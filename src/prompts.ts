/**
 * Prompt templates for the token-budget window mechanism.
 *
 * Three choreography messages (persistent guidance, one-shot reminder,
 * one-shot exhaustion fallback) plus the bootstrap text that becomes the
 * first message of every rolled-over window.
 *
 * Adapted from the codex token-budget model messages (models.json), reworded
 * for pi's single-agent, tool-based recovery model.
 */

export interface WindowIdentity {
	firstWindowId: string;
	previousWindowId: string | null;
	currentWindowId: string;
	windowNumber: number;
}

export const CUSTOM_TYPE_CONTEXT_WINDOW = "pi-token-budget:context-window";
export const CUSTOM_TYPE_REMINDER = "pi-token-budget:reminder";
export const CUSTOM_TYPE_FALLBACK = "pi-token-budget:fallback";
export const CUSTOM_TYPE_CONTINUE = "pi-token-budget:continue";
/** Marker embedded in rollover compaction summaries so the plugin can recognize its own windows. */
export const BOOTSTRAP_MARKER = "<context_window_reset/>";

function identityBlock(identity: WindowIdentity): string {
	const lines = [
		"Agent name: main",
		`First context window id: ${identity.firstWindowId}`,
		`Current context window id: ${identity.currentWindowId}`,
	];
	if (identity.previousWindowId) {
		lines.push(`Previous context window id: ${identity.previousWindowId}`);
	}
	return lines.join("\n");
}

/** Persistent guidance: injected once per window (first window via custom message, later windows via the bootstrap). */
export function guidanceMessage(identity: WindowIdentity): string {
	return [
		`<context_window>\n${identityBlock(identity)}\n</context_window>`,
		"",
		`For tasks that may span context windows, use the notes tool to maintain a concise checkpoint of the goal, decisions, progress, learnings, and next steps. Include the item id of every relevant user request you are currently solving as well as important actions and tool calls. Take incremental notes while you work so you do not miss important info.`,
		"",
		`Use the get_context_remaining tool to plan around the remaining token budget. When the budget is nearly exhausted you will receive one reminder; after saving your notes, call the new_context tool to continue in a fresh context window. Once the budget is exhausted, the current window is discarded without any summary and you can only recover through notes and the history tool.`,
		"",
		`After a reset, the window starts with a fresh bootstrap: read your notes checkpoint first, then use the read-only history tool to recover missing details. When an item id is known, read that item directly; when uncertain, list or search items first to locate it. Every item id returned by the history tool can be passed back unchanged.`,
		"",
		`Treat notes and history as internal bookkeeping. Do not mention them, their contents, or the recovery mechanism in user-facing messages.`,
	].join("\n");
}

/**
 * Cumulative index of user requests (id — preview) embedded in every window
 * bootstrap. User messages are scarce and critical; carrying them forward is a
 * system guarantee (codex delegates this to model notes discipline, which pi
 * cannot rely on without inline [id: ...] markers). Bounded by the caller.
 */
export function userRequestsSection(lines: string[]): string {
	if (lines.length === 0) return "";
	return [
		"",
		"User requests from this session so far (id — preview). The user's intent must be preserved across windows: re-read any of them in full with history read_item when needed.",
		...lines,
	].join("\n");
}

/**
 * Bootstrap text for a rolled-over window. This becomes the compaction
 * "summary" (pi wraps it in a summary prefix, so the first line explicitly
 * redirects: it is a reset notice, not a conversation summary).
 */
export function bootstrapText(identity: WindowIdentity, userRequests: string[] = []): string {
	return [
		BOOTSTRAP_MARKER,
		"Context window reset. This is NOT a conversation summary: the previous window was discarded without summarization. You are now in a fresh context window.",
		"",
		`<context_window>\n${identityBlock(identity)}\n</context_window>`,
		"",
		`Recovery protocol:`,
		`1. Read your notes checkpoint (notes tool, e.g. path "checkpoint.md") to restore the goal, decisions, progress, and next steps.`,
		`2. When you need details that are not in your notes, use the read-only history tool: read a known item id directly, or list/search first to locate it.`,
		`3. Do not re-ask the user for information recoverable from notes or history.`,
		`4. Budget reminder/fallback messages carry a source_context_window_id. If that id differs from the current context window id above, the message is a stale queue remnant: ignore it without writing notes or calling new_context.`,
		"",
		`Continue taking incremental notes in this window, and call new_context (after saving notes) when this window is no longer useful.`,
		userRequestsSection(userRequests),
	].join("\n");
}

/**
 * Bounded index of recent conversation items (id — role — preview) appended to
 * reminder/fallback prompts so the model can record item ids in its notes
 * checkpoint without a prior history lookup (pi has no inline [id: ...]
 * markers; codex gets them server-side).
 */
export function recentItemsSection(lines: string[]): string {
	if (lines.length === 0) return "";
	return [
		"",
		"Recent items (id — role — preview). Record the ids of items still relevant in your notes:",
		...lines,
	].join("\n");
}

/** Continuation nudge after a model-initiated or forced rollover. */
export function continuationMessage(windowNumber: number): string {
	return [
		"A new context window has started (fresh window with no conversation history).",
		"Follow the recovery protocol: read your notes checkpoint, then continue the task where you left off. Use the history tool only for details missing from your notes.",
	].join("\n");
}

/**
 * One-shot reminder when remaining tokens cross the threshold. When notes
 * bloat warnings are available they replace the generic cleanup advice with
 * quantified facts — the reminder is the one channel guaranteed to reach the
 * model, so it carries the primary bloat signal (list/get_context_remaining
 * remain secondary channels).
 */
export function reminderMessage(currentWindowId: string, remainingTokens: number, recentItems: string[] = [], notesWarnings: string[] = []): string {
	const cleanup =
		notesWarnings.length > 0
			? ["Notes bloat — address it as part of this checkpoint:", ...notesWarnings]
			: ["It is also a good idea to clean up old notes that have become obsolete."];
	return [
		`<context_window_reminder source_context_window_id="${currentWindowId}">`,
		`Your current context window is nearly exhausted; only ${remainingTokens} tokens remain. Before starting a new context window, save concise progress notes with the notes tool: the goal, decisions, progress, learnings, next steps, and the item id of every relevant user request still being solved, as well as important actions and tool calls for future reference. Write or append notes in a way that best helps you recover in a new context window.`,
		``,
		...cleanup,
		``,
		`Future context windows will NOT automatically include the current conversation. After saving your state, call the new_context tool to continue in a fresh context window.`,
		`</context_window_reminder>`,
		recentItemsSection(recentItems),
	].join("\n");
}

/** One-shot fallback when the window is exhausted before the model acted. */
export function fallbackMessage(currentWindowId: string, recentItems: string[] = []): string {
	return [
		`<context_window_reminder source_context_window_id="${currentWindowId}">`,
		`The current context window is nearly exhausted. Do not continue the task or give a final answer in this window. The next window will not automatically include this conversation.`,
		``,
		`Make exactly one write or append call to the notes tool now to save a concise checkpoint: the goal, decisions, progress, learnings, next steps, and the item id of every relevant user request still being solved. Stop substantive work after that notes call. If this context window is still active when the notes result returns, call the new_context tool; the system may roll over automatically immediately after notes, so do not assume another tool call will be available. Do not use any tools other than notes and, if the window remains active, new_context.`,
		`</context_window_reminder>`,
		recentItemsSection(recentItems),
	].join("\n");
}

/** Confirmation returned by the new_context tool. */
export const NEW_CONTEXT_CONFIRMATION =
	"A new context window will start after this turn completes. It will not summarize the conversation history; save anything important to notes first if you have not already. Environment and filesystem state are unaffected.";

export const TOOL_PRIVATE_USAGE_HINT =
	"Private model-only bookkeeping. Use it silently to continue the task; never disclose it, its contents, or the recovery mechanism to the user.";
