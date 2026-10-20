/**
 * Integration tests for the orchestration layer with a queue-aware pi mock.
 * sendMessage() only queues triggered messages; a custom message enters the
 * session branch only when the harness explicitly consumes that queue.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import tokenBudgetExtension from "../index.ts";
import { DEFAULTS } from "../config.ts";
import {
	COORD_CHANNEL_STATE,
	isCoordinationState,
	type TokenBudgetCoordinationState,
} from "../coordination.ts";
import {
	BOOTSTRAP_MARKER,
	CUSTOM_TYPE_CONTEXT_WINDOW,
	CUSTOM_TYPE_CONTINUE,
	CUSTOM_TYPE_FALLBACK,
	CUSTOM_TYPE_MANUAL_CHECKPOINT,
	CUSTOM_TYPE_REMINDER,
} from "../prompts.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface CustomMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

interface Sent extends CustomMessage {
	opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
}

interface BranchEntry extends CustomMessage {
	id: string;
	type: "custom_message";
}

interface CompactResult {
	cancel?: boolean;
	compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
}

interface CompactCallbacks {
	onComplete?(): void;
	onError?(error: Error): void;
}

function createHarness(sessionId = `itest-${Math.random().toString(16).slice(2)}`, initialBranch: unknown[] = []) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<
		string,
		{
			description?: string;
			promptSnippet?: string;
			parameters?: {
				required?: string[];
				additionalProperties?: boolean;
				properties?: Record<string, unknown>;
			};
			execute: (
				id: string,
				params: unknown,
				signal: undefined,
				onUpdate: unknown,
				ctx: ExtensionContext,
			) => Promise<unknown>;
		}
	>();
	const sent: Sent[] = [];
	const steering: CustomMessage[] = [];
	const followUps: CustomMessage[] = [];
	const triggeredTurns: CustomMessage[] = [];
	const compactRequests: CompactCallbacks[] = [];
	const coordinationStates: TokenBudgetCoordinationState[] = [];
	const busHandlers = new Map<string, Set<(data: unknown) => void>>();
	const events = {
		on: (channel: string, cb: (data: unknown) => void) => {
			if (!busHandlers.has(channel)) busHandlers.set(channel, new Set());
			busHandlers.get(channel)!.add(cb);
			return () => busHandlers.get(channel)?.delete(cb);
		},
		emit: (channel: string, data: unknown) => {
			for (const cb of [...(busHandlers.get(channel) ?? [])]) cb(data);
		},
	};
	events.on(COORD_CHANNEL_STATE, (data) => {
		if (isCoordinationState(data)) coordinationStates.push(data);
	});
	let branch: unknown[] = initialBranch;
	let entryCounter = 0;
	let idle = true;
	let compactCalls = 0;
	let usage: { tokens: number | null; contextWindow: number } = { tokens: null, contextWindow: 200_000 };
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-token-budget-session-"));

	const appendCustom = (message: CustomMessage): BranchEntry => {
		const entry: BranchEntry = {
			...message,
			id: `custom-${++entryCounter}`,
			type: "custom_message",
		};
		branch.push(entry);
		return entry;
	};

	const pi = {
		registerTool: (definition: { name: string; execute: never }) => {
			tools.set(definition.name, definition as never);
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		sendMessage: (message: CustomMessage, opts?: Sent["opts"]) => {
			sent.push({ ...message, opts });
			if (!opts?.triggerTurn) {
				appendCustom(message);
				return;
			}
			if (opts.deliverAs === "followUp") followUps.push(message);
			else if (opts.deliverAs === "steer") steering.push(message);
			else triggeredTurns.push(message);
		},
		events,
	} as unknown as ExtensionAPI;

	const harness = {
		pi,
		ctx: undefined as unknown as ExtensionContext,
		handlers,
		tools,
		sent,
		steering,
		followUps,
		triggeredTurns,
		coordinationStates,
		dir,
		get compactCalls() {
			return compactCalls;
		},
		get compactRequests() {
			return compactRequests;
		},
		setIdle(value: boolean) {
			idle = value;
		},
		setUsage(tokens: number | null, contextWindow = 200_000) {
			usage = { tokens, contextWindow };
		},
		setBranch(entries: unknown[]) {
			branch = entries;
		},
		getBranch() {
			return branch;
		},
		consumeSteer(): BranchEntry {
			const message = steering.shift();
			assert.ok(message, "expected a queued steering message");
			return appendCustom(message);
		},
		consumeTriggeredTurn(): BranchEntry {
			const message = triggeredTurns.shift();
			assert.ok(message, "expected a queued triggered turn");
			return appendCustom(message);
		},
		dropSteering() {
			steering.splice(0);
		},
		fire(event: string, payload: unknown): unknown {
			const handler = handlers.get(event);
			assert.ok(handler, `missing handler for ${event}`);
			const enriched =
				event === "session_before_compact"
					? { branchEntries: branch, ...(payload as Record<string, unknown>) }
					: payload;
			return handler(enriched, harness.ctx);
		},
		threshold(reason: "threshold" | "manual" | "overflow" = "threshold", tokensBefore = 195_000): CompactResult {
			const result = harness.fire("session_before_compact", {
				type: "session_before_compact",
				reason,
				willRetry: false,
				preparation: { tokensBefore },
			}) as CompactResult;
			if (result.cancel) {
				harness.fire("session_compact_failed", {
					type: "session_compact_failed",
					reason,
					aborted: true,
					willRetry: false,
					fromExtension: false,
				});
			}
			return result;
		},
		commit(compaction: NonNullable<CompactResult["compaction"]>, streaming = false): void {
			idle = !streaming;
			harness.fire("session_compact", {
				type: "session_compact",
				reason: "manual",
				willRetry: false,
				fromExtension: true,
				compactionEntry: {
					id: `compaction-${++entryCounter}`,
					type: "compaction",
					summary: compaction.summary,
					tokensBefore: compaction.tokensBefore,
				},
			});
		},
		failCompact(errorMessage: string): void {
			harness.fire("session_compact_failed", {
				type: "session_compact_failed",
				reason: "manual",
				aborted: false,
				willRetry: false,
				fromExtension: true,
				errorMessage,
			});
			const request = compactRequests.shift();
			assert.ok(request, "expected a pending ctx.compact request");
			request.onError?.(new Error(errorMessage));
		},
		cleanup() {
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};

	harness.ctx = {
		sessionManager: {
			getSessionDir: () => dir,
			getSessionId: () => sessionId,
			getLeafId: () => (branch.at(-1) as { id?: string } | undefined)?.id ?? null,
			getBranch: (fromId?: string) => {
				if (fromId === undefined) return branch;
				const index = branch.findIndex((entry) => (entry as { id?: string }).id === fromId);
				if (index < 0) throw new Error(`unknown branch entry ${fromId}`);
				return branch.slice(0, index + 1);
			},
		},
		getContextUsage: () =>
			usage.tokens === null
				? { tokens: null, contextWindow: usage.contextWindow, percent: null }
				: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: 50 },
		isIdle: () => idle,
		compact: (callbacks: CompactCallbacks) => {
			compactCalls++;
			compactRequests.push(callbacks);
		},
		ui: { notify: (_message: string, _level: string) => {} },
	} as unknown as ExtensionContext;

	tokenBudgetExtension(pi);
	harness.fire("session_start", { type: "session_start", why: "new" });
	return harness;
}

function currentWindowId(h: ReturnType<typeof createHarness>): string {
	const guidance = h.getBranch().find(
		(entry) => (entry as { customType?: string }).customType === CUSTOM_TYPE_CONTEXT_WINDOW,
	) as { content: string };
	const match = guidance.content.match(/Current context window id: (w\d+)/);
	assert.ok(match);
	return match[1];
}

function toolText(result: unknown): string {
	return ((result as { content: Array<{ type: string; text: string }> }).content[0] ?? { text: "" }).text;
}

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-token-budget-agentdir-"));
process.env.PI_AGENT_DIR = agentDir;
process.env.PI_TOKEN_BUDGET_HARD_ROLLOVER_TOKENS = "180000";

// Native Pi compaction does not contain this plugin's bootstrap guidance.
{
	const h = createHarness("native-compaction", [
		{ id: "native-compaction", type: "compaction", summary: "pi native summary, no plugin marker" },
	]);
	assert.equal(
		h.getBranch().filter((entry) => (entry as { customType?: string }).customType === CUSTOM_TYPE_CONTEXT_WINDOW).length,
		1,
	);
	h.cleanup();
}

// Guidance is persisted immediately; budget prompts are queued as steer and
// only become branch facts when consumed.
{
	const h = createHarness("delivery");
	assert.equal(h.getBranch().length, 1);
	assert.equal((h.getBranch()[0] as BranchEntry).customType, CUSTOM_TYPE_CONTEXT_WINDOW);
	assert.deepEqual([...h.tools.keys()].sort(), [
		"get_context_remaining",
		"history",
		"new_context",
		"notes",
	]);
	const modelToolSurface = [...h.tools.values()].map(({ description, promptSnippet, parameters }) => ({
		description,
		promptSnippet,
		parameters,
	}));
	assert.doesNotMatch(JSON.stringify(modelToolSurface), /pi-token-budget|token-budget/i, "model-facing tool guidance stays product-agnostic");

	h.setUsage(150_000);
	h.setIdle(false);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	assert.equal(h.steering.length, 1);
	assert.equal(h.followUps.length, 0);
	assert.equal(h.sent.at(-1)?.opts?.deliverAs, "steer");
	assert.deepEqual(h.sent.at(-1)?.details, { windowId: currentWindowId(h), kind: "reminder" });
	assert.match(h.sent.at(-1)!.content, new RegExp(`source_context_window_id="${currentWindowId(h)}"`));
	assert.equal(h.getBranch().length, 1, "queued steer must not enter branch before consumption");
	h.consumeSteer();
	assert.equal(h.getBranch().length, 2);
	h.cleanup();
}

// Notes delete is exposed as an explicit, path-safe model operation.
{
	const h = createHarness("notes-delete");
	const notesTool = h.tools.get("notes")!;
	const written = await notesTool.execute("write", { operation: "write", path: "obsolete.md", text: "old" }, undefined, undefined, h.ctx);
	assert.match(toolText(written), /Wrote 3 bytes/);
	const deleted = await notesTool.execute("delete", { operation: "delete", path: "obsolete.md" }, undefined, undefined, h.ctx);
	assert.equal(toolText(deleted), "Deleted obsolete.md.");
	const missing = await notesTool.execute("delete-missing", { operation: "delete", path: "obsolete.md" }, undefined, undefined, h.ctx);
	assert.match(toolText(missing), /no note file/);
	const escaped = await notesTool.execute("delete-escaped", { operation: "delete", path: "../outside" }, undefined, undefined, h.ctx);
	assert.match(toolText(escaped), /unsupported path component/);
	h.cleanup();
}

// The single history tool has a discriminated runtime contract, filters
// recursive bookkeeping, preserves canonical offsets, and pages snapshots.
{
	const historyBranch = [
		{ id: "hu1", type: "message", message: { role: "user", content: [{ type: "text", text: "find original quartz request" }] } },
		{
			id: "ha1",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden quartz thought" },
					{ type: "text", text: "visible answer" },
					{ type: "toolCall", id: "old-history", name: "history", arguments: { operation: "search_contents", query: "quartz" } },
					{ type: "toolCall", id: "current-search", name: "history", arguments: { operation: "search_contents", query: "self-query-only" } },
					{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "printf quartz-evidence" } },
				],
			},
		},
		{
			id: "hr1",
			type: "message",
			message: { role: "toolResult", toolName: "history", toolCallId: "old-history", content: [{ type: "text", text: "old history quartz wrapper" }] },
		},
		{
			id: "hr2",
			type: "message",
			message: { role: "toolResult", toolCallId: "bash-call", content: [{ type: "text", text: "quartz-evidence" }] },
		},
		{ id: "hc1", type: "custom_message", customType: CUSTOM_TYPE_REMINDER, content: "internal reminder" },
	];
	const h = createHarness("history-tools", historyBranch);
	const historyTool = h.tools.get("history")!;
	assert.equal(h.tools.has("history_search"), false, "transient split tools are not registered");
	assert.deepEqual(historyTool.parameters!.required, ["operation"]);
	assert.equal(historyTool.parameters!.additionalProperties, false);
	assert.throws(
		() =>
			validateToolArguments(
				{ name: "history", parameters: historyTool.parameters } as never,
				{ type: "toolCall", id: "schema-missing", name: "history", arguments: {} },
			),
		/operation/,
		"pinned runtime rejects a missing operation",
	);
	assert.throws(
		() =>
			validateToolArguments(
				{ name: "history", parameters: historyTool.parameters } as never,
				{ type: "toolCall", id: "schema-unknown", name: "history", arguments: { operation: "list_windows", surprise: true } },
			),
		/additional|unexpected/i,
		"pinned runtime rejects unknown fields",
	);

	const task = await historyTool.execute("current-search", { operation: "search_contents", query: "quartz" }, undefined, undefined, h.ctx);
	assert.doesNotMatch(JSON.stringify(task), /pi-token-budget|token-budget/i, "history feedback stays product-agnostic");
	assert.match(toolText(task), /hu1/);
	assert.match(toolText(task), /hr2/);
	assert.doesNotMatch(toolText(task), /hr1|old history quartz wrapper|hidden quartz thought/);
	const self = await historyTool.execute(
		"current-search",
		{ operation: "search_contents", query: "self-query-only", scope: "all" },
		undefined,
		undefined,
		h.ctx,
	);
	assert.match(toolText(self), /No matching history records/);
	const diagnostic = await historyTool.execute(
		"another-call",
		{ operation: "search_contents", query: "old history quartz wrapper", scope: "all" },
		undefined,
		undefined,
		h.ctx,
	);
	assert.match(toolText(diagnostic), /hr1/);
	assert.match(toolText(diagnostic), /internal=true/);
	const sourced = await historyTool.execute(
		"source-search",
		{ operation: "search_contents", query: "quartz-evidence", tool_name: "bash", recent_first: false },
		undefined,
		undefined,
		h.ctx,
	);
	assert.match(toolText(sourced), /\[hr2\]/);
	assert.doesNotMatch(toolText(sourced), /\[ha1\]/, "tool_name alone implies tool_result");

	const list = await historyTool.execute(
		"list-call",
		{ operation: "list_items", role: "assistant" },
		undefined,
		undefined,
		h.ctx,
	);
	assert.match(toolText(list), /visible answer/);
	assert.doesNotMatch(toolText(list), /tool_call history/);
	const read = await historyTool.execute(
		"read-call",
		{ operation: "read_item", item_id: "hr1", limit_chars: 100 },
		undefined,
		undefined,
		h.ctx,
	);
	assert.match(toolText(read), /old history quartz wrapper/);
	assert.match(toolText(read), /tool_name=history/);

	const missingId = await historyTool.execute("bad-read", { operation: "read_item" }, undefined, undefined, h.ctx);
	assert.equal((missingId as { isError?: boolean }).isError, true);
	assert.match(toolText(missingId), /history read_item failed \[invalid_arguments\]/);
	assert.deepEqual(
		h.fire("tool_result", {
			type: "tool_result",
			toolName: "history",
			toolCallId: "bad-read",
			input: { operation: "read_item" },
			content: (missingId as { content: unknown }).content,
			details: (missingId as { details: unknown }).details,
			isError: false,
		}),
		{ isError: true },
		"pinned hosts receive the error marker through the tool_result hook",
	);
	for (const params of [
		{ operation: "search_contents", query: "   " },
		{ operation: "search_contents", query: "quartz", offset_chars: 1 },
		{ operation: "list_items", limit: "20" },
		{ operation: "list_windows", role: "user" },
	]) {
		const invalid = await historyTool.execute("bad-args", params, undefined, undefined, h.ctx);
		assert.equal((invalid as { isError?: boolean }).isError, true);
		assert.match(toolText(invalid), /invalid_arguments/);
	}
	const noMatch = await historyTool.execute(
		"no-match",
		{ operation: "search_contents", query: "definitely-absent" },
		undefined,
		undefined,
		h.ctx,
	);
	assert.notEqual((noMatch as { isError?: boolean }).isError, true, "no matches is a successful empty result");

	h.setBranch([
		...historyBranch,
		{ id: "long-item", type: "message", message: { role: "user", content: [{ type: "text", text: "x".repeat(20_000) }] } },
	]);
	const longRead = await historyTool.execute(
		"long-read",
		{ operation: "read_item", item_id: "long-item", limit_chars: 100_000 },
		undefined,
		undefined,
		h.ctx,
	);
	const longText = toolText(longRead);
	assert.ok(longText.length <= DEFAULTS.maxToolOutputChars);
	const range = longText.match(/showing=0\.\.(\d+)/);
	assert.ok(range);
	const nextOffsetMarker = longText.lastIndexOf("\nnext_offset_chars=");
	assert.equal(
		longText.slice(longText.indexOf("\n") + 1, nextOffsetMarker < 0 ? undefined : nextOffsetMarker).length,
		Number(range[1]),
		"read header range matches delivered body",
	);

	const bulkBranch = Array.from({ length: 80 }, (_, index) => ({
		id: `bulk-${index}`,
		type: "message",
		message: { role: "user", content: [{ type: "text", text: `bulk ${index} ${"z".repeat(600)}` }] },
	}));
	h.setBranch(bulkBranch);
	const packed = await historyTool.execute(
		"packed-list",
		{ operation: "list_items", limit: 200, recent_first: false },
		undefined,
		undefined,
		h.ctx,
	);
	const packedText = toolText(packed);
	const packedDetails = packed as { details: { records: Array<{ itemId: string }>; nextCursor?: string } };
	assert.ok(packedText.length <= 6000, "list/search index responses use the tighter output budget");
	assert.ok(packedDetails.details.nextCursor, "budget packing emits a continuation cursor");
	for (const record of packedDetails.details.records) assert.match(packedText, new RegExp(`\\[${record.itemId}\\]`));
	assert.equal((packedText.match(/^\[bulk-/gm) ?? []).length, packedDetails.details.records.length, "only complete records are delivered");

	const firstPage = await historyTool.execute(
		"bulk-list",
		{ operation: "list_items", limit: 3, recent_first: false },
		undefined,
		undefined,
		h.ctx,
	);
	const firstText = toolText(firstPage);
	assert.match(firstText, /\[bulk-0\]/);
	assert.match(firstText, /\[bulk-2\]/);
	assert.doesNotMatch(firstText, /\[bulk-3\]/);
	const cursor = (firstPage as { details: { nextCursor?: string } }).details.nextCursor;
	assert.ok(cursor);

	// Appends after page one do not enter the fixed snapshot.
	h.setBranch([...bulkBranch, { id: "bulk-new", type: "message", message: { role: "user", content: "new append" } }]);
	const secondPage = await historyTool.execute(
		"bulk-next",
		{ operation: "list_items", cursor },
		undefined,
		undefined,
		h.ctx,
	);
	assert.match(toolText(secondPage), /\[bulk-3\]/);
	assert.doesNotMatch(toolText(secondPage), /bulk-new/);

	const searchPage = await historyTool.execute(
		"search-page",
		{ operation: "search_contents", query: "bulk", limit: 2, recent_first: false },
		undefined,
		undefined,
		h.ctx,
	);
	const searchCursor = (searchPage as { details: { nextCursor?: string } }).details.nextCursor;
	assert.ok(searchCursor);
	const searchNext = await historyTool.execute(
		"search-next",
		{ operation: "search_contents", cursor: searchCursor },
		undefined,
		undefined,
		h.ctx,
	);
	assert.match(toolText(searchNext), /\[bulk-2\]/);
	const wrongOperation = await historyTool.execute(
		"wrong-operation",
		{ operation: "list_items", cursor: searchCursor },
		undefined,
		undefined,
		h.ctx,
	);
	assert.match(toolText(wrongOperation), /cursor_operation_mismatch/);

	const tampered = `${cursor!.slice(0, -1)}${cursor!.endsWith("A") ? "B" : "A"}`;
	const badCursor = await historyTool.execute(
		"bad-cursor",
		{ operation: "list_items", cursor: tampered },
		undefined,
		undefined,
		h.ctx,
	);
	assert.equal((badCursor as { isError?: boolean }).isError, true);
	assert.match(toolText(badCursor), /invalid_cursor/);

	const resumed = createHarness("history-tools", bulkBranch);
	const resumedPage = await resumed.tools.get("history")!.execute(
		"resume-cursor",
		{ operation: "list_items", cursor },
		undefined,
		undefined,
		resumed.ctx,
	);
	assert.match(toolText(resumedPage), /\[bulk-3\]/, "cursor survives extension restart in the same session");
	resumed.cleanup();

	const wrongSession = createHarness("history-other-session", bulkBranch);
	const mismatch = await wrongSession.tools.get("history")!.execute(
		"wrong-session",
		{ operation: "list_items", cursor },
		undefined,
		undefined,
		wrongSession.ctx,
	);
	assert.match(toolText(mismatch), /cursor_session_mismatch/);
	wrongSession.cleanup();

	h.setBranch(bulkBranch.slice(0, 20));
	const stale = await historyTool.execute(
		"stale-branch",
		{ operation: "list_items", cursor },
		undefined,
		undefined,
		h.ctx,
	);
	assert.match(toolText(stale), /cursor_stale_branch/);
	h.cleanup();
}

// Persisted guidance from the transient split-tool release gets one
// request-local context message; current single-tool guidance gets none.
{
	const splitGuidance = {
		id: "split-guidance",
		type: "custom_message",
		customType: CUSTOM_TYPE_CONTEXT_WINDOW,
		content: "Use history_list_items, history_search, and history_read_item after reset.",
		display: false,
	};
	const h = createHarness("split-history-guidance", [splitGuidance]);
	const before = h.getBranch().length;
	const baseMessages = [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: 1 }];
	const first = h.fire("context", { type: "context", messages: baseMessages }) as { messages: Array<{ role: string; content: unknown }> };
	assert.equal(first.messages.length, 2);
	assert.match(String(first.messages[1].content), /single history tool/);
	assert.match(String(first.messages[1].content), /operation field/);
	assert.equal(h.getBranch().length, before, "migration guidance is request-local, not a session entry");
	assert.equal(h.fire("context", { type: "context", messages: baseMessages }), undefined, "hint is one-shot");
	h.cleanup();

	const current = createHarness("current-history-guidance", [
		{ ...splitGuidance, id: "current-guidance", content: "Use history with operation read_item for a known id." },
	]);
	assert.equal(
		current.fire("context", { type: "context", messages: baseMessages }),
		undefined,
		"current guidance does not receive a migration hint",
	);
	current.cleanup();
}

// Two-state threshold flow: reminder in branch -> fallback opportunity ->
// fallback in branch -> no-summary rollover.
{
	const h = createHarness("threshold-two-state");
	h.setUsage(150_000);
	h.setIdle(false);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	h.consumeSteer();

	let result = h.threshold();
	assert.deepEqual(result, { cancel: true });
	assert.equal(h.steering.length, 1);
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_FALLBACK);
	assert.deepEqual(h.sent.at(-1)?.details, { windowId: currentWindowId(h), kind: "fallback" });
	assert.match(h.sent.at(-1)!.content, /exactly one write or append call/);
	assert.match(h.sent.at(-1)!.content, /system may roll over automatically/);
	h.consumeSteer();

	result = h.threshold();
	assert.ok(result.compaction);
	assert.ok(result.compaction!.summary.includes(BOOTSTRAP_MARKER));
	assert.match(result.compaction!.summary, /stale queue remnant/);
	assert.match(result.compaction!.firstKeptEntryId, /^token-budget-rollover-/);
	assert.ok(!result.compaction!.summary.includes("exactly one write"), "old fallback content must not enter bootstrap");

	h.setIdle(true);
	h.commit(result.compaction!);
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_CONTINUE);
	assert.deepEqual(h.sent.at(-1)?.opts, { triggerTurn: true });
	h.cleanup();
}

// Checkpoint fence: it arms only after fallback delivery, admits exactly one
// notes write/append, blocks all other tools, and rolls over after success.
{
	const h = createHarness("checkpoint-fence");
	h.setUsage(181_000, 200_000);
	h.setIdle(false);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	assert.equal(h.steering.length, 1);
	assert.equal(h.fire("tool_call", { type: "tool_call", toolCallId: "pre", toolName: "bash", input: { command: "echo pre" } }), undefined);
	const fallback = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: fallback.customType, content: fallback.content, details: fallback.details },
	});
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 0, "settled boundary must wait for the checkpoint");
	h.setIdle(false);
	assert.deepEqual(h.threshold(), { cancel: true }, "automatic compaction must wait for the checkpoint");

	for (const toolName of ["bash", "read", "edit", "write", "subagent", "todo"]) {
		const blocked = h.fire("tool_call", { type: "tool_call", toolCallId: `blocked-${toolName}`, toolName, input: {} }) as Record<string, unknown>;
		assert.equal(blocked.block, true, `${toolName} must be blocked`);
		assert.equal(blocked.terminate, true, `${toolName} must terminate the batch`);
	}
	for (const operation of ["read", "search", "list", "delete"]) {
		const blocked = h.fire("tool_call", {
			type: "tool_call",
			toolCallId: `blocked-notes-${operation}`,
			toolName: "notes",
			input: { operation, path: "checkpoint.md" },
		}) as Record<string, unknown>;
		assert.equal(blocked.block, true);
	}

	const notesTool = h.tools.get("notes")!;
	assert.equal(h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "notes-write",
		toolName: "notes",
		input: { operation: "write", path: "checkpoint.md", text: "state" },
	}), undefined);
	const saved = await notesTool.execute("notes-write", { operation: "write", path: "checkpoint.md", text: "state" }, undefined, undefined, h.ctx) as Record<string, unknown>;
	assert.equal(saved.terminate, true);
	const secondWrite = h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "second-write",
		toolName: "notes",
		input: { operation: "append", path: "checkpoint.md", text: "more" },
	}) as Record<string, unknown>;
	assert.equal(secondWrite.block, true);
	assert.equal(secondWrite.terminate, true);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 1, "successful checkpoint must request rollover");
	const compacted = h.threshold("manual", 181_000);
	assert.ok(compacted.compaction);
	h.commit(compacted.compaction!);
	assert.equal(h.fire("tool_call", { type: "tool_call", toolCallId: "post", toolName: "bash", input: {} }), undefined);
	h.cleanup();
}

// A failed checkpoint write releases its claim so a corrected write can retry.
{
	const h = createHarness("checkpoint-retry");
	h.setUsage(181_000, 200_000);
	h.setIdle(false);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	const fallback = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: fallback.customType, content: fallback.content, details: fallback.details },
	});
	const call = (id: string, operation: string, pathValue: string) => h.fire("tool_call", {
		type: "tool_call", toolCallId: id, toolName: "notes", input: { operation, path: pathValue, text: "retry" },
	});
	assert.equal(call("bad", "write", "../invalid"), undefined);
	const failed = await h.tools.get("notes")!.execute("bad", { operation: "write", path: "../invalid", text: "retry" }, undefined, undefined, h.ctx) as Record<string, unknown>;
	assert.equal(failed.terminate, undefined);
	assert.equal(call("good", "append", "checkpoint.md"), undefined);
	const retried = await h.tools.get("notes")!.execute("good", { operation: "append", path: "checkpoint.md", text: "retry" }, undefined, undefined, h.ctx) as Record<string, unknown>;
	assert.equal(retried.terminate, true);
	h.cleanup();
}

// Bootstrap indexes keep the most recent entries: user requests (recency on
// overflow + omission pointer) and edited files (dedupe by path, recency,
// bounded, omission pointer).
{
	const h = createHarness("bootstrap-indexes");
	const branch = h.getBranch();
	for (let i = 1; i <= 30; i++) {
		branch.push({
			id: `u-${i}`,
			type: "message",
			message: { role: "user", content: [{ type: "text", text: `request ${i} fix the login flow` }] },
		});
		branch.push({
			id: `a-${i}`,
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: `src/file${i}.ts` } }] },
		});
	}
	// Re-edit an early file late: dedupe must keep the newest item id.
	branch.push({
		id: "a-re",
		type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: "src/file1.ts" } }] },
	});

	const summary = (h.threshold("overflow") as CompactResult).compaction!.summary;
	// User requests: newest 25 of 30 kept, chronological, 5 omitted with pointer.
	assert.ok(summary.includes("u-6 —"), "25th-from-last user request indexed");
	assert.ok(summary.includes("u-30 —"), "newest user request indexed");
	assert.ok(!summary.includes("u-5 —"), "older-than-25 user request dropped");
	assert.ok(summary.indexOf("u-6 —") < summary.indexOf("u-30 —"), "index stays chronological");
	assert.match(summary, /5 older user request\(s\) not shown/);
	assert.match(summary, /history with \{"operation":"list_items","role":"user"\}/);
	// Edited files: 30 distinct paths -> 5 kept, file1 deduped to its latest edit.
	assert.ok(summary.includes("Files edited in this session"));
	assert.ok(summary.includes("src/file1.ts (last edit: a-re)"), "dedupe keeps most recent edit id");
	assert.ok(summary.includes("src/file30.ts (last edit: a-30)"));
	assert.ok(!summary.includes("src/file2.ts"), "file edited only early is dropped");
	assert.match(summary, /25 other file\(s\) also edited/);
	assert.match(summary, /history with \{"operation":"search_contents","query":"\[tool_call edit\]","kind":"tool_call"\}/);
	h.cleanup();
}

// A stale old-window fallback is not evidence for the current window.
{
	const h = createHarness("stale-source");
	h.setBranch([
		...h.getBranch(),
		{
			id: "stale-fallback",
			type: "custom_message",
			customType: CUSTOM_TYPE_FALLBACK,
			content: "old",
			display: true,
			details: { windowId: "w-old0000", kind: "fallback" },
		},
	]);
	const result = h.threshold();
	assert.deepEqual(result, { cancel: true });
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_REMINDER);
	h.cleanup();
}

// Esc recovery for both two-state threshold messages. Persistent flags cannot
// substitute for branch delivery.
{
	const h = createHarness("threshold-esc");
	h.setUsage(150_000);
	h.setIdle(false);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	h.dropSteering();
	assert.deepEqual(h.threshold(), { cancel: true });
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_REMINDER);
	h.consumeSteer();

	assert.deepEqual(h.threshold(), { cancel: true });
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_FALLBACK);
	h.dropSteering();
	assert.deepEqual(h.threshold(), { cancel: true });
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_FALLBACK);
	h.consumeSteer();
	assert.ok(h.threshold().compaction);
	h.cleanup();
}

// A user /compact request first runs one fenced checkpoint turn, then rolls
// over and resumes unfinished work without requiring new_context.
{
	const h = createHarness("manual-checkpoint");
	h.setUsage(100_000, 200_000);
	const branchLength = h.getBranch().length;
	assert.deepEqual(h.threshold("manual", 100_000), { cancel: true });
	assert.equal(h.getBranch().length, branchLength, "queued checkpoint prompt is not a branch fact before delivery");
	assert.equal(h.steering.length, 1);
	assert.equal(h.steering[0].customType, CUSTOM_TYPE_MANUAL_CHECKPOINT);
	assert.match(h.steering[0].content, /user requested a fresh context window/i);
	assert.match(h.steering[0].content, /exactly one notes write or append/i);
	assert.match(h.steering[0].content, /Do not call new_context/);
	assert.doesNotMatch(h.steering[0].content, /nearly exhausted/i);
	assert.equal(h.coordinationStates.at(-1)?.phase, "checkpoint_required");

	// A repeated command before the first prompt is delivered merges into the
	// same request instead of adding another model instruction.
	assert.deepEqual(h.threshold("manual", 100_000), { cancel: true });
	assert.equal(h.steering.length, 1);

	const checkpointPrompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: {
			role: "custom",
			customType: checkpointPrompt.customType,
			content: checkpointPrompt.content,
			details: checkpointPrompt.details,
		},
	});
	const blocked = h.fire("tool_call", { type: "tool_call", toolCallId: "manual-blocked", toolName: "bash", input: {} }) as Record<string, unknown>;
	assert.equal(blocked.block, true);
	assert.equal(blocked.terminate, true);

	const notes = h.tools.get("notes")!;
	assert.equal(
		h.fire("tool_call", {
			type: "tool_call",
			toolCallId: "manual-note",
			toolName: "notes",
			input: { operation: "write", path: "checkpoint.md", text: "manual checkpoint" },
		}),
		undefined,
	);
	const saved = await notes.execute(
		"manual-note",
		{ operation: "write", path: "checkpoint.md", text: "manual checkpoint" },
		undefined,
		undefined,
		h.ctx,
	) as Record<string, unknown>;
	assert.equal(saved.terminate, true);
	assert.equal(h.coordinationStates.at(-1)?.phase, "rollover_pending");

	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 1);
	const compacted = h.threshold("manual", 100_000);
	assert.ok(compacted.compaction);
	h.commit(compacted.compaction!);
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_CONTINUE);
	assert.match(h.sent.at(-1)!.content, /continue any unfinished task/i);
	assert.match(h.sent.at(-1)!.content, /If no unfinished task remains, wait for the user/i);
	h.cleanup();
}

// The cancellation event for the first native /compact may race with the
// checkpoint agent. A note that already succeeded must not be reset by that
// expected cancellation.
{
	const h = createHarness("manual-checkpoint-cancel-race");
	const first = h.fire("session_before_compact", {
		type: "session_before_compact",
		reason: "manual",
		willRetry: false,
		preparation: { tokensBefore: 100_000 },
	}) as CompactResult;
	assert.deepEqual(first, { cancel: true });
	const prompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: prompt.customType, content: prompt.content, details: prompt.details },
	});
	h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "race-note",
		toolName: "notes",
		input: { operation: "write", path: "checkpoint.md", text: "won the race" },
	});
	await h.tools.get("notes")!.execute(
		"race-note",
		{ operation: "write", path: "checkpoint.md", text: "won the race" },
		undefined,
		undefined,
		h.ctx,
	);
	h.fire("session_compact_failed", {
		type: "session_compact_failed",
		reason: "manual",
		aborted: true,
		willRetry: false,
		fromExtension: false,
	});
	assert.equal(h.coordinationStates.at(-1)?.phase, "rollover_pending");
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 1, "the successful racing note still schedules rollover");
	h.cleanup();
}

// Esc during the checkpoint agent turn cancels the user-requested rollover and
// stale checkpoint instructions are removed from later model contexts.
{
	const h = createHarness("manual-checkpoint-esc");
	assert.deepEqual(h.threshold("manual", 100_000), { cancel: true });
	const checkpointPrompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: {
			role: "custom",
			customType: checkpointPrompt.customType,
			content: checkpointPrompt.content,
			details: checkpointPrompt.details,
		},
	});
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
	assert.equal(h.fire("tool_call", { type: "tool_call", toolCallId: "after-esc", toolName: "bash", input: {} }), undefined);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 0);
	const filtered = h.fire("context", {
		type: "context",
		messages: [{
			role: "custom",
			customType: checkpointPrompt.customType,
			content: checkpointPrompt.content,
			details: checkpointPrompt.details,
			display: true,
			timestamp: 1,
		}],
	}) as { messages: unknown[] };
	assert.deepEqual(filtered.messages, []);
	h.cleanup();
}

// Esc after the notes write but before agent_settled keeps the durable note,
// cancels automatic rollover, and permits an explicit retry without rewriting.
{
	const h = createHarness("manual-checkpoint-esc-after-save");
	assert.deepEqual(h.threshold("manual", 100_000), { cancel: true });
	const prompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: prompt.customType, content: prompt.content, details: prompt.details },
	});
	h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "saved-then-esc",
		toolName: "notes",
		input: { operation: "write", path: "checkpoint.md", text: "durable" },
	});
	await h.tools.get("notes")!.execute(
		"saved-then-esc",
		{ operation: "write", path: "checkpoint.md", text: "durable" },
		undefined,
		undefined,
		h.ctx,
	);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 0);
	assert.equal(h.coordinationStates.at(-1)?.phase, "rollover_pending");
	assert.ok(h.threshold("manual", 100_000).compaction);
	h.cleanup();
}

// A real compaction failure keeps the successful manual checkpoint reusable;
// an explicit /compact retry does not ask the model to write it again.
{
	const h = createHarness("manual-checkpoint-retry");
	assert.deepEqual(h.threshold("manual", 100_000), { cancel: true });
	const prompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: prompt.customType, content: prompt.content, details: prompt.details },
	});
	const notes = h.tools.get("notes")!;
	h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "retry-note",
		toolName: "notes",
		input: { operation: "append", path: "checkpoint.md", text: "saved once" },
	});
	await notes.execute(
		"retry-note",
		{ operation: "append", path: "checkpoint.md", text: "saved once" },
		undefined,
		undefined,
		h.ctx,
	);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	const failedAttempt = h.threshold("manual", 100_000);
	assert.ok(failedAttempt.compaction);
	h.failCompact("manual rollover failed");
	assert.deepEqual(
		{ phase: h.coordinationStates.at(-1)?.phase, error: h.coordinationStates.at(-1)?.error },
		{ phase: "rollover_pending", error: "manual rollover failed" },
	);
	const promptsBeforeRetry = h.steering.length;
	const retry = h.threshold("manual", 100_000);
	assert.ok(retry.compaction);
	assert.equal(h.steering.length, promptsBeforeRetry, "retry reuses the saved checkpoint");
	h.commit(retry.compaction!);
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_CONTINUE);
	h.cleanup();
}

// Esc while the post-checkpoint compaction itself is running stops automatic
// retry but preserves the saved checkpoint for a later explicit /compact.
{
	const h = createHarness("manual-compaction-esc");
	assert.deepEqual(h.threshold("manual", 100_000), { cancel: true });
	const prompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: prompt.customType, content: prompt.content, details: prompt.details },
	});
	h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "compact-esc-note",
		toolName: "notes",
		input: { operation: "write", path: "checkpoint.md", text: "saved before Esc" },
	});
	await h.tools.get("notes")!.execute(
		"compact-esc-note",
		{ operation: "write", path: "checkpoint.md", text: "saved before Esc" },
		undefined,
		undefined,
		h.ctx,
	);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 1);
	assert.ok(h.threshold("manual", 100_000).compaction);
	h.fire("session_compact_failed", {
		type: "session_compact_failed",
		reason: "manual",
		aborted: true,
		willRetry: false,
		fromExtension: true,
	});
	const compactRequest = h.compactRequests.shift();
	assert.ok(compactRequest);
	compactRequest.onError?.(new Error("Compaction cancelled"));
	assert.equal(h.coordinationStates.at(-1)?.phase, "rollover_pending");
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 1, "Esc must not retry compaction automatically");
	const retry = h.threshold("manual", 100_000);
	assert.ok(retry.compaction, "a later explicit command reuses the saved checkpoint");
	h.cleanup();
}

// Normal user activity after a failed manual rollover invalidates that saved
// checkpoint, reopens tools, and requires a fresh checkpoint on the next command.
{
	const h = createHarness("manual-checkpoint-invalidated");
	assert.deepEqual(h.threshold("manual", 100_000), { cancel: true });
	const prompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: prompt.customType, content: prompt.content, details: prompt.details },
	});
	h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "invalidate-note",
		toolName: "notes",
		input: { operation: "write", path: "checkpoint.md", text: "soon stale" },
	});
	await h.tools.get("notes")!.execute(
		"invalidate-note",
		{ operation: "write", path: "checkpoint.md", text: "soon stale" },
		undefined,
		undefined,
		h.ctx,
	);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.ok(h.threshold("manual", 100_000).compaction);
	h.failCompact("manual rollover failed");
	h.fire("message_end", { type: "message_end", message: { role: "user", content: "new work" } });
	assert.equal(h.coordinationStates.at(-1)?.phase, "ready");
	assert.equal(h.fire("tool_call", { type: "tool_call", toolCallId: "new-work", toolName: "bash", input: {} }), undefined);
	assert.deepEqual(h.threshold("manual", 100_000), { cancel: true });
	assert.equal(h.steering.at(-1)?.customType, CUSTOM_TYPE_MANUAL_CHECKPOINT);
	h.cleanup();
}

// Overflow remains an emergency no-checkpoint path and does not synthesize a
// continuation when no model, fallback, or manual request exists.
{
	const h = createHarness("short-overflow");
	const result = h.threshold("overflow", 190_000);
	assert.ok(result.compaction);
	assert.equal(h.steering.length, 0);
	h.commit(result.compaction!);
	assert.notEqual(h.sent.at(-1)?.customType, CUSTOM_TYPE_CONTINUE);
	h.cleanup();
}

// Hard rollover below pi's own contextWindow-16384 threshold: if Esc drops the
// fallback, agent_settled re-steers it; the following settled boundary rolls.
{
	const h = createHarness("hard-esc-gap");
	h.setUsage(181_000, 200_000); // >= hard 180k, but < pi threshold 183,616
	h.setIdle(false);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_FALLBACK);
	h.dropSteering();

	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 0, "must not compact until fallback reaches branch");
	assert.equal(h.steering.length, 1, "settled must recover the lost hard fallback");
	h.consumeSteer();
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 1, "next settled boundary must fulfill hard rollover");

	const result = h.threshold("manual", 181_000);
	assert.ok(result.compaction);
	h.commit(result.compaction!);
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_CONTINUE);
	h.cleanup();
}

// Pi reports an extension-cancelled threshold compaction as
// session_compact_failed(aborted=true). That attempt must not consume the
// hard-rollover intent; otherwise the lost-fallback recovery cannot run.
{
	const h = createHarness("hard-cancel-preserves-rollover");
	h.setUsage(181_000, 200_000);
	h.setIdle(false);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_FALLBACK);

	assert.deepEqual(h.threshold(), { cancel: true });
	assert.deepEqual(
		{ phase: h.coordinationStates.at(-1)?.phase, error: h.coordinationStates.at(-1)?.error },
		{ phase: "checkpoint_required", error: undefined },
	);
	h.dropSteering();

	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.steering.length, 1, "aborted threshold attempt must preserve lost-fallback recovery");
	const fallback = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: fallback.customType, content: fallback.content, details: fallback.details },
	});

	const notes = h.tools.get("notes")!;
	assert.equal(
		h.fire("tool_call", {
			type: "tool_call",
			toolCallId: "checkpoint-after-cancel",
			toolName: "notes",
			input: { operation: "write", path: "checkpoint.md", text: "state" },
		}),
		undefined,
	);
	await notes.execute(
		"checkpoint-after-cancel",
		{ operation: "write", path: "checkpoint.md", text: "state" },
		undefined,
		undefined,
		h.ctx,
	);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 1, "hard rollover must still compact after the recovered checkpoint");
	const result = h.threshold("manual", 181_000);
	assert.ok(result.compaction);
	h.commit(result.compaction!);
	assert.equal(h.coordinationStates.at(-1)?.windowId, "w2");
	h.cleanup();
}

// Repeated new_context calls are collapsed by pendingNewContext and
// compactionInFlight without changing the public tool result.
{
	const h = createHarness("new-context-idempotent");
	h.setIdle(false);
	const tool = h.tools.get("new_context")!;
	const results = await Promise.all([
		tool.execute("nc-1", {}, undefined, undefined, h.ctx),
		tool.execute("nc-2", {}, undefined, undefined, h.ctx),
		tool.execute("nc-3", {}, undefined, undefined, h.ctx),
	]);
	assert.deepEqual(results[0], results[1]);
	assert.deepEqual(results[1], results[2]);
	assert.equal(h.compactCalls, 0);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 1);
	const result = h.threshold("manual", 160_000);
	assert.ok(result.compaction);
	h.commit(result.compaction!);
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_CONTINUE);
	h.cleanup();
}

// A proactive new_context hands the model copyable item ids while the old
// window can still act on them — and the fresh window pays nothing for it.
{
	const h = createHarness("new-context-anchors");
	h.setBranch([
		{ id: "u-1", type: "message", message: { role: "user", content: [{ type: "text", text: "fix the parser panic" }] } },
		{ id: "a-1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: "src/p.ts" } }] } },
		{ id: "g-1", type: "custom_message", customType: CUSTOM_TYPE_CONTEXT_WINDOW, content: "window guidance", display: false },
		{ id: "f-1", type: "custom_message", customType: "reframe:audit", content: "a foreign extension message", display: false },
	]);
	h.setIdle(false);
	const confirmation = toolText(await h.tools.get("new_context")!.execute("nc-anchors", {}, undefined, undefined, h.ctx));
	assert.ok(confirmation.includes("u-1 — user — fix the parser panic"), "user request ids are anchored");
	assert.ok(confirmation.includes("a-1 — assistant — [tool_call edit]"), "tool-call anchors are copyable");
	assert.ok(confirmation.includes("f-1 — custom —"), "only this plugin's own messages are filtered");
	assert.ok(!confirmation.includes("g-1"), "the plugin's bookkeeping must not eat an index slot");

	const result = h.threshold("manual", 160_000);
	assert.ok(result.compaction);
	assert.ok(!result.compaction!.summary.includes("[tool_call edit]"), "the anchor index stays in the old window");
	assert.ok(!result.compaction!.summary.includes("Recent items"), "the bootstrap gains no recent-items section");
	assert.ok(result.compaction!.summary.includes("fix the parser panic"), "the user-request index still crosses over");
	h.commit(result.compaction!);
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_CONTINUE);
	h.cleanup();
}

// The threshold reminder uses the same filtered index, so a prior window's
// guidance/reminder entries cannot crowd out real conversation.
{
	const h = createHarness("reminder-index-filtered");
	h.setBranch([
		{ id: "u-9", type: "message", message: { role: "user", content: [{ type: "text", text: "audit the fence" }] } },
		{ id: "g-9", type: "custom_message", customType: CUSTOM_TYPE_CONTEXT_WINDOW, content: "window guidance", display: false },
	]);
	h.setUsage(150_000);
	h.setIdle(false);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	const reminder = h.steering[0];
	assert.equal(reminder?.customType, CUSTOM_TYPE_REMINDER);
	assert.ok(reminder.content.includes("u-9 — user — audit the fence"), "reminder carries the anchor ids");
	assert.ok(!reminder.content.includes("g-9"), "guidance is not conversation");
	h.cleanup();
}

// A fallback-armed rollover keeps continuation as steer if compaction commits
// while pi still reports streaming.
{
	const h = createHarness("streaming-continuation");
	h.setUsage(150_000);
	h.setIdle(false);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	h.consumeSteer();
	h.threshold();
	h.consumeSteer();
	const result = h.threshold();
	assert.ok(result.compaction);
	h.commit(result.compaction!, true);
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_CONTINUE);
	assert.deepEqual(h.sent.at(-1)?.opts, { triggerTurn: true, deliverAs: "steer" });
	h.cleanup();
}

// A deferred rollover that fails before session_before_compact must publish
// the real post-cleanup phase instead of leaving clients at rolling_over.
{
	const h = createHarness("failure-before-before-compact");
	h.setIdle(false);
	await h.tools.get("new_context")!.execute("nc-fail-early", {}, undefined, undefined, h.ctx);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 1);
	assert.equal(h.coordinationStates.at(-1)?.phase, "rolling_over");

	h.failCompact("Nothing to compact");
	assert.deepEqual(
		{ phase: h.coordinationStates.at(-1)?.phase, error: h.coordinationStates.at(-1)?.error },
		{ phase: "ready", error: "Nothing to compact" },
	);
	h.cleanup();
}

// The same cleanup is required after session_before_compact created a
// pending window: pendingWindow and pendingNewContext must both be cleared.
{
	const h = createHarness("failure-after-before-compact");
	h.setIdle(false);
	await h.tools.get("new_context")!.execute("nc-fail-pending", {}, undefined, undefined, h.ctx);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.ok(h.threshold("manual", 160_000).compaction);
	assert.equal(h.coordinationStates.at(-1)?.phase, "rolling_over");

	h.failCompact("provider rejected compaction");
	assert.deepEqual(
		{ phase: h.coordinationStates.at(-1)?.phase, error: h.coordinationStates.at(-1)?.error },
		{ phase: "ready", error: "provider rejected compaction" },
	);
	h.cleanup();
}

// A failed fallback/checkpoint rollover reopens the checkpoint fence and
// advertises checkpoint_required so the continuation owner does not resume.
{
	const h = createHarness("failure-checkpoint-required");
	h.setUsage(181_000, 200_000);
	h.setIdle(false);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
	const fallback = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: fallback.customType, content: fallback.content, details: fallback.details },
	});
	const notes = h.tools.get("notes")!;
	assert.equal(
		h.fire("tool_call", {
			type: "tool_call",
			toolCallId: "checkpoint-before-failure",
			toolName: "notes",
			input: { operation: "write", path: "checkpoint.md", text: "state" },
		}),
		undefined,
	);
	await notes.execute(
		"checkpoint-before-failure",
		{ operation: "write", path: "checkpoint.md", text: "state" },
		undefined,
		undefined,
		h.ctx,
	);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.ok(h.threshold("manual", 181_000).compaction);
	h.failCompact("checkpoint rollover failed");
	assert.deepEqual(
		{ phase: h.coordinationStates.at(-1)?.phase, error: h.coordinationStates.at(-1)?.error },
		{ phase: "checkpoint_required", error: "checkpoint rollover failed" },
	);
	h.cleanup();
}

fs.rmSync(agentDir, { recursive: true, force: true });
console.log("integration: all assertions passed");
