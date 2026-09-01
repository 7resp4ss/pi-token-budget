/**
 * pi-token-budget: token-budget context window management for pi.
 *
 * Replaces summarization compaction with no-summary window rollover:
 *
 * - get_context_remaining / new_context model tools (pull + deferred push)
 * - one-shot threshold reminder and exhaustion fallback per window
 * - notes: model-authored checkpoints that survive rollovers
 * - history: read-only, bounded random access to prior windows
 *
 * Design invariants:
 * 1. The in-flight response is never interrupted: injections and rollovers
 *    happen at request/turn boundaries only.
 * 2. History is append-only; stale reminders stay stale (cache friendly).
 * 3. Per-window injection is bounded: 1x identity/guidance + <=1x reminder
 *    + <=1x fallback + bounded tool outputs. Rollover resets the budget.
 * 4. Rollover carries no summary: the new window opens with a bootstrap
 *    notice, fresh initial context, and the recovery protocol.
 *
 * Entry point: `export default function (pi: ExtensionAPI)`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, reminderThreshold, resolveForModel, type ConfigBundle, type TokenBudgetConfig } from "./config.ts";
import { HistoryStore } from "./stores/history-store.ts";
import { NotesStore } from "./stores/notes-store.ts";
import {
	BOOTSTRAP_MARKER,
	CUSTOM_TYPE_CONTEXT_WINDOW,
	CUSTOM_TYPE_CONTINUE,
	CUSTOM_TYPE_FALLBACK,
	CUSTOM_TYPE_REMINDER,
	bootstrapText,
	continuationMessage,
	fallbackMessage,
	guidanceMessage,
	reminderMessage,
} from "./prompts.ts";
import {
	commitRollover,
	freshState,
	generateWindowId,
	inferFromBranch,
	loadState,
	saveState,
	type PendingWindow,
	type WindowState,
} from "./state.ts";
import { registerWindowTools } from "./tools/index.ts";
import { notesBloatWarnings } from "./tools/deps.ts";

interface LooseEntry {
	id: string;
	type: string;
	summary?: string;
	customType?: string;
	details?: unknown;
}

type BudgetMessageKind = "reminder" | "fallback";

interface BudgetMessageDetails {
	windowId: string;
	kind: BudgetMessageKind;
}

interface BeforeCompactEventLike {
	reason: string;
	branchEntries: unknown[];
	preparation: { tokensBefore: number };
}

export default function tokenBudgetExtension(pi: ExtensionAPI): void {
	const bundle: ConfigBundle = loadConfig();
	/** Effective config for the active model (memoized per provider/model). */
	let modelConfigKey = "";
	let modelConfig: TokenBudgetConfig = bundle.defaults;
	function effectiveConfig(ctx: ExtensionContext): TokenBudgetConfig {
		const model = ctx.model;
		if (!model) return bundle.defaults;
		const key = `${model.provider}/${model.id}`;
		if (key !== modelConfigKey) {
			modelConfigKey = key;
			modelConfig = resolveForModel(bundle, model.provider, model.id);
		}
		return modelConfig;
	}

	// ---------------------------------------------------------------------
	// Mutable per-session state (reinitialized on session_start)
	// ---------------------------------------------------------------------
	let state: WindowState = freshState("pending-session");
	let notes: NotesStore | null = null;
	let sessionDir = "";
	/** Pending rollover awaiting commit by session_compact. */
	let pendingWindow: PendingWindow | null = null;
	/** Rollover request from new_context, awaiting the turn boundary. */
	let rolloverRequested = false;
	let compactionInFlight = false;
	/** Timestamp (ms) of the last committed rollover; guards stale usage. */
	let lastRolloverTimestamp = 0;
	/** Continue the task in the new window after a model-initiated or forced rollover. */
	let continueAfterRollover = false;

	function persist(): void {
		if (sessionDir) saveState(sessionDir, state);
	}

	function currentBranch(ctx: ExtensionContext): LooseEntry[] {
		return ctx.sessionManager.getBranch() as unknown as LooseEntry[];
	}

	function injectPassive(piApi: ExtensionAPI, customType: string, content: string, display: boolean): void {
		piApi.sendMessage(
			{ customType, content, display, details: undefined },
			{ triggerTurn: false },
		);
	}

	function injectBudget(piApi: ExtensionAPI, customType: string, content: string, display: boolean, kind: BudgetMessageKind): void {
		const details: BudgetMessageDetails = { windowId: state.currentWindowId, kind };
		piApi.sendMessage(
			{ customType, content, display, details },
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}

	function currentWindowHasMessage(
		branch: LooseEntry[],
		customType: string,
		currentWindowId: string,
		kind: BudgetMessageKind,
	): boolean {
		return branch.some((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== customType) return false;
			const details = entry.details as Partial<BudgetMessageDetails> | undefined;
			return details?.windowId === currentWindowId && details.kind === kind;
		});
	}

	function sendReminder(ctx: ExtensionContext, remaining: number): void {
		const activeNotes = notes;
		injectBudget(
			pi,
			CUSTOM_TYPE_REMINDER,
			reminderMessage(
				state.currentWindowId,
				remaining,
				recentItemLines(ctx),
				activeNotes ? notesBloatWarnings(() => activeNotes, bundle.defaults) : [],
			),
			true,
			"reminder",
		);
	}

	function sendFallback(ctx: ExtensionContext): void {
		injectBudget(
			pi,
			CUSTOM_TYPE_FALLBACK,
			fallbackMessage(state.currentWindowId, recentItemLines(ctx)),
			true,
			"fallback",
		);
	}

	/** Bounded recent-item index (id — role — preview) for checkpoint prompts. */
	function recentItemLines(ctx: ExtensionContext): string[] {
		const items = new HistoryStore(currentBranch(ctx)).listItems({
			recentFirst: true,
			limit: 25,
			previewChars: 120,
		});
		return items
			.reverse() // chronological order for readability
			.map((i) => `${i.itemId} — ${i.role} — ${i.preview.replace(/\s+/g, " ")}`);
	}

	/**
	 * Cumulative user-request index (id — preview) across ALL windows in the
	 * session tree, embedded in every bootstrap. System-guaranteed so the new
	 * window can never lose sight of what the user asked for, even when the
	 * model never recorded ids in notes.
	 */
	function userRequestLines(branch: Array<{ id: string; type: string; summary?: string; customType?: string }>): string[] {
		const items = new HistoryStore(branch as never).listItems({
			role: "user",
			limit: 25,
			previewChars: 160,
		});
		return items.map((i) => `${i.itemId} — ${i.preview.replace(/\s+/g, " ")}`);
	}

	/** Whether the current window already has its identity/guidance message. */
	function windowHasGuidance(branch: LooseEntry[]): boolean {
		let lastCompaction = -1;
		for (let i = 0; i < branch.length; i++) {
			if (branch[i].type === "compaction") lastCompaction = i;
		}
		if (lastCompaction >= 0 && typeof branch[lastCompaction].summary === "string") {
			// Rollover bootstraps carry guidance themselves.
			return true;
		}
		for (let i = lastCompaction + 1; i < branch.length; i++) {
			if (branch[i].type === "custom_message" && branch[i].customType === CUSTOM_TYPE_CONTEXT_WINDOW) return true;
		}
		return false;
	}

	function buildRollover(event: BeforeCompactEventLike) {
		// Autonomous continuation belongs to an existing model/fallback request,
		// not to the manual/overflow reason that happened to commit it.
		continueAfterRollover = state.pendingNewContext || state.fallbackActive;

		pendingWindow = { id: generateWindowId(), number: state.windowNumber + 1 };
		const identity = {
			firstWindowId: state.firstWindowId,
			previousWindowId: state.currentWindowId,
			currentWindowId: pendingWindow.id,
			windowNumber: pendingWindow.number,
		};
		return {
			compaction: {
				summary: bootstrapText(identity, userRequestLines(event.branchEntries as never)),
				// Sentinel id that matches no entry: the new window keeps nothing
				// from the old conversation (pi keeps entries from this id only).
				firstKeptEntryId: `token-budget-rollover-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
				tokensBefore: event.preparation.tokensBefore,
			},
		};
	}

	// ---------------------------------------------------------------------
	// Tools
	// ---------------------------------------------------------------------
	if (bundle.defaults.enabled) {
		registerWindowTools(pi, {
			config: bundle.defaults,
			getState: () => state,
			requestRollover: () => {
				state = { ...state, pendingNewContext: true };
				rolloverRequested = true;
				persist();
			},
			getNotes: () => {
				if (!notes) throw new Error("session not initialized yet");
				return notes;
			},
			buildHistory: (ctx: ExtensionContext) => new HistoryStore(currentBranch(ctx)),			triggerCompaction: (ctx: ExtensionContext) => {
				startDeferredRollover(ctx);
			},
			remainingTokens: (ctx: ExtensionContext) => {
				const usage = ctx.getContextUsage();
				if (!usage || usage.tokens === null || usage.contextWindow <= 0) return null;
				return Math.max(0, usage.contextWindow - usage.tokens);
			},
		});
	}

	// ---------------------------------------------------------------------
	// Session lifecycle
	// ---------------------------------------------------------------------
	pi.on("session_start", (_event, ctx) => {
		if (!bundle.defaults.enabled) return;
		sessionDir = ctx.sessionManager.getSessionDir();
		const sessionId = ctx.sessionManager.getSessionId();
		const branch = currentBranch(ctx);
		const loaded = loadState(sessionDir, sessionId);
		state = loaded.sessionId === sessionId ? inferFromBranch(loaded, branch) : freshState(sessionId);
		notes = new NotesStore(sessionDir, sessionId, bundle.defaults.notesMaxFileBytes);
		pendingWindow = null;
		rolloverRequested = false;
		compactionInFlight = false;
		continueAfterRollover = false;
		persist();

		// First-window guidance (later windows bootstrap via the rollover summary).
		if (state.windowNumber === 1 && !windowHasGuidance(branch)) {
			injectPassive(
				pi,
				CUSTOM_TYPE_CONTEXT_WINDOW,
				guidanceMessage({
					firstWindowId: state.firstWindowId,
					previousWindowId: state.previousWindowId,
					currentWindowId: state.currentWindowId,
					windowNumber: state.windowNumber,
				}),
				false,
			);
		}
	});

	// ---------------------------------------------------------------------
	// Trigger channel: one-shot reminder at the remaining-token threshold,
	// plus an optional absolute hard rollover (used-tokens level) that forces
	// the no-summary rollover at the next turn boundary. Both fire only after
	// an assistant message completes — never mid-response.
	// ---------------------------------------------------------------------
	pi.on("message_end", (event, ctx) => {
		if (!bundle.defaults.enabled) return;
		const msg = event.message as { role?: string; stopReason?: string; timestamp?: number };
		if (msg?.role !== "assistant" || msg.stopReason === "aborted") return;
		// Skip messages from before the last rollover: their usage reflects the
		// discarded window and must not re-trigger anything (mirrors pi's own
		// assistantIsFromBeforeCompaction guard).
		if (msg.timestamp !== undefined && msg.timestamp <= lastRolloverTimestamp) return;
		if (state.pendingNewContext) return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.contextWindow <= 0) return;
		const eff = effectiveConfig(ctx);
		const used = usage.tokens;
		const remaining = Math.max(0, usage.contextWindow - used);

		// Hard rollover: absolute used-tokens level, with hysteresis latch.
		const hard = eff.hardRolloverUsedTokens;
		if (hard > 0) {
			if (used < hard * 0.9) {
				if (state.hardRolloverLatched) {
					state = { ...state, hardRolloverLatched: false };
					persist();
				}
			} else if (used >= hard && !state.hardRolloverLatched && !state.fallbackActive) {
				state = {
					...state,
					reminderDelivered: true,
					fallbackDelivered: true,
					fallbackActive: true,
					hardRolloverLatched: true,
				};
				persist();
				sendFallback(ctx);
				rolloverRequested = true; // consumed at agent_settled
				return;
			}
		}

		if (state.reminderDelivered) return;
		const threshold = reminderThreshold(eff, usage.contextWindow);
		if (remaining > threshold) return;
		state = { ...state, reminderDelivered: true };
		persist();
		sendReminder(ctx, remaining);
	});

	// ---------------------------------------------------------------------
	// Rollover: intercept every compaction and replace summarization with a
	// no-summary fresh window (except the first threshold crossing, which
	// cancels once to give the model the fallback checkpoint prompt).
	// ---------------------------------------------------------------------
	pi.on("session_before_compact", (event, ctx) => {
		if (!bundle.defaults.enabled) return undefined;
		const compactEvent = event as BeforeCompactEventLike;

		// Explicit model/user/runtime reasons must never be swallowed by the
		// threshold checkpoint choreography.
		if (state.pendingNewContext || compactEvent.reason === "manual" || compactEvent.reason === "overflow") {
			return buildRollover(compactEvent);
		}

		const branch = compactEvent.branchEntries as LooseEntry[];
		const fallbackInBranch = currentWindowHasMessage(
			branch,
			CUSTOM_TYPE_FALLBACK,
			state.currentWindowId,
			"fallback",
		);
		if (fallbackInBranch) {
			if (!state.fallbackActive || !state.fallbackDelivered) {
				state = { ...state, reminderDelivered: true, fallbackDelivered: true, fallbackActive: true };
				persist();
			}
			return buildRollover(compactEvent);
		}

		if (state.fallbackActive) {
			// The fallback was armed but never reached the branch (for example Esc
			// cleared an in-memory queue). Re-offer it before any rollover.
			sendFallback(ctx);
			return { cancel: true };
		}

		const reminderInBranch = currentWindowHasMessage(
			branch,
			CUSTOM_TYPE_REMINDER,
			state.currentWindowId,
			"reminder",
		);
		if (!reminderInBranch) {
			state = { ...state, reminderDelivered: true };
			persist();
			const usage = ctx.getContextUsage();
			const remaining = usage?.tokens === null || !usage ? 0 : Math.max(0, usage.contextWindow - usage.tokens);
			sendReminder(ctx, remaining);
			return { cancel: true };
		}

		state = { ...state, reminderDelivered: true, fallbackDelivered: true, fallbackActive: true };
		persist();
		sendFallback(ctx);
		return { cancel: true };
	});

	pi.on("session_compact", (event, ctx) => {
		if (!bundle.defaults.enabled) return;
		const summary = (event.compactionEntry as { summary?: string; timestamp?: string } | undefined)?.summary;
		if (typeof summary !== "string" || !summary.includes(BOOTSTRAP_MARKER) || !pendingWindow) return;
		const entryTs = (event.compactionEntry as { timestamp?: string }).timestamp;
		if (entryTs) lastRolloverTimestamp = new Date(entryTs).getTime() || 0;
		if (continueAfterRollover) {
			continueAfterRollover = false;
			// Compaction normally commits between turns. If pi completes it while
			// still streaming, preserve steering delivery instead of follow-up.
			pi.sendMessage(
				{ customType: CUSTOM_TYPE_CONTINUE, content: continuationMessage(state.windowNumber), display: true, details: undefined },
				ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "steer" },
			);
		}
		const previous = state.windowNumber;
		state = commitRollover(state, pendingWindow);
		pendingWindow = null;
		rolloverRequested = false;
		compactionInFlight = false;
		persist();
		console.log(`pi-token-budget: context window reset ${previous} -> ${state.windowNumber} (id ${state.currentWindowId})`);
	});

	pi.on("session_compact_failed", (event, _ctx) => {
		if (!bundle.defaults.enabled) return;
		pendingWindow = null;
		compactionInFlight = false;
		continueAfterRollover = false;
		// aborted=true is expected: our one-shot threshold cancel.
		// On a real rollover failure, fallbackActive stays set so the next
		// threshold crossing retries the rollover.
	});

	// ---------------------------------------------------------------------
	// Deferred rollover for model-requested new_context: run at the turn
	// boundary, never mid-response.
	// ---------------------------------------------------------------------
	function startDeferredRollover(ctx: ExtensionContext): void {
		if (compactionInFlight || !ctx.isIdle()) return;
		compactionInFlight = true;
		rolloverRequested = false;
		ctx.compact({
			onComplete: () => {
				compactionInFlight = false;
			},
			onError: (err: Error) => {
				compactionInFlight = false;
				state = { ...state, pendingNewContext: false };
				persist();
				ctx.ui.notify(`pi-token-budget: rollover failed: ${err.message}`, "warning");
			},
		});
	}

	pi.on("agent_settled", (_event, ctx) => {
		if (!bundle.defaults.enabled) return;
		if (
			rolloverRequested &&
			state.fallbackActive &&
			!currentWindowHasMessage(currentBranch(ctx), CUSTOM_TYPE_FALLBACK, state.currentWindowId, "fallback")
		) {
			// A hard rollover may be armed below pi's own threshold. If Esc removed
			// its steer, re-send it here; the next settled boundary will compact
			// after the fallback has actually entered the branch.
			sendFallback(ctx);
			return;
		}
		if (rolloverRequested || state.pendingNewContext) startDeferredRollover(ctx);
	});

	pi.on("session_shutdown", () => {
		pendingWindow = null;
		rolloverRequested = false;
		compactionInFlight = false;
		continueAfterRollover = false;
	});
}
