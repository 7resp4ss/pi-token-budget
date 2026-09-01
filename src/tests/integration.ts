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
import tokenBudgetExtension from "../index.ts";
import {
	BOOTSTRAP_MARKER,
	CUSTOM_TYPE_CONTEXT_WINDOW,
	CUSTOM_TYPE_CONTINUE,
	CUSTOM_TYPE_FALLBACK,
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

function createHarness(sessionId = `itest-${Math.random().toString(16).slice(2)}`) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<
		string,
		{
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
	let branch: unknown[] = [];
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
		dir,
		get compactCalls() {
			return compactCalls;
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
			return harness.fire("session_before_compact", {
				type: "session_before_compact",
				reason,
				willRetry: false,
				preparation: { tokensBefore },
			}) as CompactResult;
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
		cleanup() {
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};

	harness.ctx = {
		sessionManager: {
			getSessionDir: () => dir,
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
		getContextUsage: () =>
			usage.tokens === null
				? { tokens: null, contextWindow: usage.contextWindow, percent: null }
				: { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: 50 },
		isIdle: () => idle,
		compact: () => {
			compactCalls++;
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
	const match = guidance.content.match(/Current context window id: (w-[^\s<]+)/);
	assert.ok(match);
	return match[1];
}

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-token-budget-agentdir-"));
process.env.PI_AGENT_DIR = agentDir;
process.env.PI_TOKEN_BUDGET_HARD_ROLLOVER_TOKENS = "180000";

// Guidance is persisted immediately; budget prompts are queued as steer and
// only become branch facts when consumed.
{
	const h = createHarness("delivery");
	assert.equal(h.getBranch().length, 1);
	assert.equal((h.getBranch()[0] as BranchEntry).customType, CUSTOM_TYPE_CONTEXT_WINDOW);
	assert.deepEqual([...h.tools.keys()].sort(), ["get_context_remaining", "history", "new_context", "notes"]);

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

// Manual and overflow compactions bypass checkpoint cancellation and do not
// synthesize autonomous continuation when no model/fallback request exists.
for (const reason of ["manual", "overflow"] as const) {
	const h = createHarness(`short-${reason}`);
	const result = h.threshold(reason, 190_000);
	assert.ok(result.compaction, `${reason} must roll over directly`);
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

fs.rmSync(agentDir, { recursive: true, force: true });
console.log("integration: all assertions passed");
