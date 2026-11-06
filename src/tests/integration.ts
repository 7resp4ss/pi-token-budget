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
import { TOOL_SPECS } from "../tools/specs.ts";
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
	const notifications: string[] = [];
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
	let abortCalls = 0;
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
		notifications,
		dir,
		get abortCalls() {
			return abortCalls;
		},
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
				signal: new AbortController().signal,
			}) as CompactResult;
			assert.ok(!(result instanceof Promise), "use beginManual() for a new manual checkpoint");
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
		async beginManual(signal = new AbortController().signal): Promise<CompactResult> {
			const result = await harness.fire("session_before_compact", {
				type: "session_before_compact", reason: "manual", willRetry: false,
				preparation: { tokensBefore: 100_000 }, signal,
			}) as CompactResult;
			if (result.cancel) harness.fire("session_compact_failed", {
				type: "session_compact_failed", reason: "manual", aborted: true, willRetry: false, fromExtension: false,
			});
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
		failCompact(errorMessage: string, native = false): void {
			harness.fire("session_compact_failed", {
				type: "session_compact_failed",
				reason: "manual",
				aborted: false,
				willRetry: false,
				fromExtension: true,
				errorMessage,
			});
			const request = compactRequests.shift();
			if (!native) assert.ok(request, "expected a pending ctx.compact request");
			request?.onError?.(new Error(errorMessage));
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
		abort: () => { abortCalls++; },
		compact: (callbacks: CompactCallbacks) => {
			compactCalls++;
			compactRequests.push(callbacks);
		},
		ui: { notify: (message: string, _level: string) => { notifications.push(message); } },
	} as unknown as ExtensionContext;

	tokenBudgetExtension(pi);
	void harness.fire("session_start", { type: "session_start", why: "new" });
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
	assert.deepEqual([...h.tools.keys()].sort(), Object.keys(TOOL_SPECS).sort());

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

// Legacy aggregate tools and model-visible deletion are removed.
{
	const h = createHarness("no-aggregate-tools");
	assert.equal(h.tools.has("notes"), false);
	assert.equal(h.tools.has("history"), false);
	assert.equal(h.tools.has("notes_delete_file"), false);
	h.cleanup();
}

// The remote history fixes also apply to the independent tool surface:
// no recursive recovery noise, exact read coordinates, complete bounded rows,
// strict per-function arguments, and direct reads of known internal item IDs.
{
	const h = createHarness("precise-history", [
		{ id: "history-user", type: "message", message: { role: "user", content: "A😀needleZ\ntail needle" } },
		{ id: "mixed", type: "message", message: { role: "assistant", content: [
			{ type: "thinking", thinking: "hidden needle thought" },
			{ type: "text", text: "visible explanation" },
			{ type: "toolCall", id: "evidence-call", name: "alpha.probe", arguments: { query: "needle" } },
			{ type: "toolCall", id: "old-search", name: "history_search_contents", arguments: { query: "needle" } },
			{ type: "toolCall", id: "current-search", name: "history_search_contents", arguments: { query: "self-only-token" } },
		] } },
		{ id: "old-wrapper", type: "message", message: { role: "toolResult", toolCallId: "old-search", content: "recursive needle wrapper" } },
		{ id: "evidence-result", type: "message", message: { role: "toolResult", toolCallId: "evidence-call", toolName: "wrong.name", content: "needle-evidence" } },
	]);
	const rows = (result: unknown): Array<Record<string, unknown>> => toolText(result).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
	const search = (params: unknown, id = "current-search") => h.tools.get("history_search_contents")!.execute(id, params, undefined, undefined, h.ctx);
	const task = await search({ query: "needle" });
	assert.deepEqual(rows(task).map(row => row.item_id), ["history-user", "mixed", "evidence-result"]);
	assert.doesNotMatch(toolText(task), /old-wrapper|hidden needle thought|recursive needle wrapper/);
	const diagnostic = await search({ query: "recursive", tool_namespace: "history" });
	assert.deepEqual(rows(diagnostic).map(row => row.item_id), ["old-wrapper"]);
	assert.equal(rows(await search({ query: "self-only-token", tool_namespace: "history" })).length, 0, "executing call never echoes itself");
	const filtered = rows(await search({ query: "needle-evidence", tool_namespace: "alpha", tool_name: "probe", role: "tool" }));
	assert.deepEqual(filtered.map(row => row.item_id), ["evidence-result"], "linked call wins over inconsistent result metadata");
	const user = rows(task)[0] as { regions: Array<{ matches: Array<{ start: number; end: number }>; offset_chars: number; limit_chars: number }> };
	assert.deepEqual(user.regions.flatMap(region => region.matches), [{ start: 2, end: 8 }, { start: 15, end: 21 }]);
	for (const region of user.regions) {
		const read = await h.tools.get("history_read_item")!.execute("read-match", { window_id: "w1", item_id: "history-user", offset_chars: region.offset_chars, limit_chars: region.limit_chars }, undefined, undefined, h.ctx);
		assert.match(toolText(read).split("\n").slice(1).join("\n"), /needle/);
	}
	await assert.rejects(search({ query: "   " }), /cannot be blank/);
	await assert.rejects(search({ query: "needle", offset_chars: 1 }), /unknown field/);
	await assert.rejects(search({ query: "needle", limit: "20" }), /Invalid parameters/);
	await assert.rejects(h.tools.get("history_list_windows")!.execute("bad-filter", { role: "user" }, undefined, undefined, h.ctx), /unknown field/);
	await assert.rejects(h.tools.get("history_read_item")!.execute("bad-read", { item_id: "history-user" }, undefined, undefined, h.ctx), /Invalid parameters/);
	assert.equal(rows(await search({ query: "absent" })).length, 0, "no match remains a successful result");
	const readInternal = await h.tools.get("history_read_item")!.execute("read-internal", { window_id: "w1", item_id: "old-wrapper" }, undefined, undefined, h.ctx);
	assert.match(toolText(readInternal), /recursive needle wrapper/);

	h.setBranch(Array.from({ length: 80 }, (_, index) => ({ id: `packed-${index}`, type: "message", message: { role: "user", content: `needle ${index} ${"\n\t\u0001🙂".repeat(1000)}` } })));
	for (const [tool, params] of [
		["history_list_items", { limit: 200, max_chars_per_item: 100_000 }],
		["history_search_contents", { query: "needle", limit: 200 }],
	] as const) {
		const result = await h.tools.get(tool)!.execute("pack", params, undefined, undefined, h.ctx);
		assert.ok(Array.from(toolText(result)).length <= 6000, "index output has a strict 6000-character ceiling");
		assert.ok(rows(result).length > 0, "oversized previews still return a whole record");
		assert.match(toolText(result), /rows omitted by output cap/);
		assert.equal((toolText(result).match(/^\{/gm) ?? []).length, rows(result).length, "JSON rows are never cut in half");
	}
	h.cleanup();
}

// Persisted aggregate-tool guidance receives one request-local correction.
{
	const oldGuidance = { id: "old-guidance", type: "custom_message", customType: CUSTOM_TYPE_CONTEXT_WINDOW, content: "Use the history tool with operation read_item.", display: false };
	const h = createHarness("aggregate-migration", [oldGuidance]);
	const before = h.getBranch().length;
	const messages = [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: 1 }];
	const first = h.fire("context", { messages }) as { messages: Array<{ customType?: string; content?: unknown }> };
	assert.match(JSON.stringify(first.messages), /eleven independent tools/);
	assert.match(JSON.stringify(first.messages), /Do not pass an operation field/);
	assert.equal(h.getBranch().length, before, "migration remains request-local");
	const second = h.fire("context", { messages }) as { messages: Array<{ customType?: string }> };
	assert.equal(second.messages.some(message => message.customType?.endsWith("history-migration")), false, "migration is one-shot");
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
	assert.match(h.sent.at(-1)!.content, /system requests rollover automatically/);
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
	for (const toolName of ["notes_read_file", "notes_search_contents", "notes_list_files_by_prefix"]) {
		const blocked = h.fire("tool_call", {
			type: "tool_call",
			toolCallId: `blocked-${toolName}`,
			toolName,
			input: { path: "checkpoint.md" },
		}) as Record<string, unknown>;
		assert.equal(blocked.block, true);
	}

	const notesTool = h.tools.get("notes_write_file")!;
	assert.equal(h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "notes-write",
		toolName: "notes_write_file",
		input: { path: "checkpoint.md", text: "state" },
	}), undefined);
	const saved = await notesTool.execute("notes-write", { path: "checkpoint.md", text: "state" }, undefined, undefined, h.ctx) as Record<string, unknown>;
	assert.equal(saved.terminate, true);
	const secondWrite = h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "second-write",
		toolName: "notes_write_file",
		input: { path: "checkpoint.md", text: "more" },
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
		type: "tool_call", toolCallId: id, toolName: operation === "write" ? "notes_write_file" : "notes_append_to_file", input: { path: pathValue, text: "retry" },
	});
	assert.equal(call("bad", "write", "../invalid"), undefined);
	await assert.rejects(h.tools.get("notes_write_file")!.execute("bad", { path: "../invalid", text: "retry" }, undefined, undefined, h.ctx), /unsupported path component/);
	assert.equal(call("good", "append", "checkpoint.md"), undefined);
	const retried = await h.tools.get("notes_append_to_file")!.execute("good", { path: "checkpoint.md", text: "retry" }, undefined, undefined, h.ctx) as Record<string, unknown>;
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
	assert.match(summary, /list_items role "user"/);
	// Edited files: 30 distinct paths -> 5 kept, file1 deduped to its latest edit.
	assert.ok(summary.includes("Files edited in this session"));
	assert.ok(summary.includes("src/file1.ts (last edit: a-re)"), "dedupe keeps most recent edit id");
	assert.ok(summary.includes("src/file30.ts (last edit: a-30)"));
	assert.ok(!summary.includes("src/file2.ts"), "file edited only early is dropped");
	assert.match(summary, /25 other file\(s\) also edited/);
	assert.match(summary, /search_contents "\[tool_call"/);
	h.cleanup();
}

// Reset-time notes discovery reads real metadata, produces callable paths,
// and stays bounded without injecting note bodies or blocking an overflow.
{
	const sessionId = "bootstrap-notes";
	const h = createHarness(sessionId);
	const root = path.join(h.dir, "pi-token-budget", "notes", sessionId);
	const reset = () => {
		const result = h.threshold("overflow");
		assert.ok(result.compaction);
		return result.compaction.summary;
	};
	const index = (summary: string) => summary.slice(summary.indexOf("\nExisting notes for "));
	const rows = (summary: string): Array<{ path: string; bytes: number; updated_at: string }> => index(summary).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
	assert.match(reset(), /No note files were found for this agent/);
	const write = (notePath: string, text: string) => h.tools.get("notes_write_file")!.execute("save", { path: notePath, text }, undefined, undefined, h.ctx);
	const unusualPath = 'plan "quoted"\n.md';
	await write("older.md", "OLD_NOTE_BODY_CANARY");
	await write(unusualPath, "LATEST_NOTE_BODY_CANARY");
	fs.utimesSync(path.join(root, "older.md"), new Date("2026-01-01"), new Date("2026-01-01"));
	fs.utimesSync(path.join(root, unusualPath), new Date("2026-02-01"), new Date("2026-02-01"));
	const summary = reset();
	const listed = rows(summary);
	assert.deepEqual(listed.map(row => row.path), [`/root/notes/${unusualPath}`, "/root/notes/older.md"]);
	assert.equal(listed[0].bytes, Buffer.byteLength("LATEST_NOTE_BODY_CANARY"));
	assert.equal(listed[0].updated_at, new Date("2026-02-01").toISOString());
	assert.doesNotMatch(summary, /NOTE_BODY_CANARY/);
	assert.doesNotMatch((h.fire("before_agent_start", { systemPrompt: "base" }) as { systemPrompt: string }).systemPrompt, /older\.md|quoted|NOTE_BODY_CANARY/);
	for (const row of listed) {
		const read = await h.tools.get("notes_read_file")!.execute("recover", { path: row.path }, undefined, undefined, h.ctx);
		assert.match(toolText(read), /NOTE_BODY_CANARY/, "listed paths are passed unchanged to notes_read_file");
	}
	for (let i = 0; i < 30; i++) await write(`extra-${i}.md`, "body");
	const many = reset();
	assert.equal(rows(many).length, 25);
	assert.match(many, /7 additional note file\(s\) omitted/);
	assert.ok(Array.from(index(many)).length <= 6000);

	fs.rmSync(root, { recursive: true });
	for (let i = 0; i < 30; i++) await write(`${"a".repeat(160)}/${"b".repeat(160)}/${i}-${"c".repeat(150)}.md`, "LONG_PATH_NOTE_BODY_CANARY");
	const long = reset();
	assert.ok(rows(long).length > 0 && rows(long).length < 25, "long paths stop before the section character cap");
	assert.ok(Array.from(index(long)).length <= 6000);
	assert.match(long, /additional note file\(s\) omitted/);
	assert.doesNotMatch(long, /LONG_PATH_NOTE_BODY_CANARY/);
	for (const row of rows(long)) assert.match(toolText(await h.tools.get("notes_read_file")!.execute("recover-long", { path: row.path }, undefined, undefined, h.ctx)), /LONG_PATH_NOTE_BODY_CANARY/);

	fs.rmSync(root, { recursive: true });
	fs.writeFileSync(root, "not a directory");
	const unavailable = reset();
	assert.match(unavailable, /notes index is unavailable/);
	assert.doesNotMatch(unavailable, /No note files were found/, "listing errors must not be reported as an empty store");
	assert.match(unavailable, /notes_list_files_by_prefix/);
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

	const notes = h.tools.get("notes_write_file")!;
	assert.equal(
		h.fire("tool_call", {
			type: "tool_call",
			toolCallId: "checkpoint-after-cancel",
			toolName: "notes_write_file",
			input: { path: "checkpoint.md", text: "state" },
		}),
		undefined,
	);
	await notes.execute(
		"checkpoint-after-cancel",
		{ path: "checkpoint.md", text: "state" },
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

// Proactive rollover confirms that the checkpoint must already be saved.
{
	const h = createHarness("new-context-checkpoint-first");
	h.setIdle(false);
	const result = await h.tools.get("new_context")!.execute("nc", {}, undefined, undefined, h.ctx) as Record<string, unknown>;
	assert.equal(result.terminate, true);
	assert.match(toolText(result), /must already be saved/);
	assert.ok(!toolText(result).includes("make one notes append"));
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
	const notes = h.tools.get("notes_write_file")!;
	assert.equal(
		h.fire("tool_call", {
			type: "tool_call",
			toolCallId: "checkpoint-before-failure",
			toolName: "notes_write_file",
			input: { path: "checkpoint.md", text: "state" },
		}),
		undefined,
	);
	await notes.execute(
		"checkpoint-before-failure",
		{ path: "checkpoint.md", text: "state" },
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

// A user /compact request first runs one fenced checkpoint turn, then rolls
// over and resumes unfinished work without requiring new_context.
{
	const h = createHarness("manual-checkpoint");
	h.setUsage(100_000, 200_000);
	const branchLength = h.getBranch().length;
	const reset = h.beginManual();
	let returned = false;
	void reset.then(() => { returned = true; });
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

	const notes = h.tools.get("notes_write_file")!;
	assert.equal(
		h.fire("tool_call", {
			type: "tool_call",
			toolCallId: "manual-note",
			toolName: "notes_write_file",
			input: { path: "checkpoint.md", text: "manual checkpoint" },
		}),
		undefined,
	);
	const saved = await notes.execute(
		"manual-note",
		{ path: "checkpoint.md", text: "manual checkpoint" },
		undefined,
		undefined,
		h.ctx,
	) as Record<string, unknown>;
	assert.equal(saved.terminate, true);
	assert.equal(h.coordinationStates.at(-1)?.phase, "rollover_pending");
	assert.equal(returned, false, "do not replace context during the note tool batch");

	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	const compacted = await reset;
	assert.equal(h.compactCalls, 0, "the original native compaction performs the reset");
	assert.ok(compacted.compaction);
	h.commit(compacted.compaction!);
	assert.equal(h.sent.at(-1)?.customType, CUSTOM_TYPE_CONTINUE);
	assert.match(h.sent.at(-1)!.content, /continue any unfinished task/i);
	assert.match(h.sent.at(-1)!.content, /If no unfinished task remains, wait for the user/i);
	h.cleanup();
}

// Automatic threshold/overflow attempts during a manual checkpoint cannot
// bypass the fence, replace the context mid-run, or reset a successful note.
{
	const h = createHarness("manual-checkpoint-auto-race");
	const reset = h.beginManual();
	const prompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: prompt.customType, content: prompt.content, details: prompt.details },
	});
	assert.deepEqual(h.threshold("threshold"), { cancel: true });
	assert.deepEqual(h.threshold("overflow"), { cancel: true });
	assert.equal(h.coordinationStates.at(-1)?.phase, "checkpoint_required");
	h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "race-note",
		toolName: "notes_write_file",
		input: { path: "checkpoint.md", text: "won the race" },
	});
	await h.tools.get("notes_write_file")!.execute(
		"race-note",
		{ path: "checkpoint.md", text: "won the race" },
		undefined,
		undefined,
		h.ctx,
	);
	assert.deepEqual(h.threshold("threshold"), { cancel: true });
	assert.equal(h.coordinationStates.at(-1)?.phase, "rollover_pending");
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.ok((await reset).compaction, "the successful note completes the original manual rollover");
	assert.equal(h.compactCalls, 0);
	h.cleanup();
}

// A failed note cannot discard the window. The native attempt ends when the
// run settles, leaves the fence armed, and an explicit retry can save normally.
{
	const h = createHarness("manual-checkpoint-write-failed");
	const reset = h.beginManual();
	const prompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: prompt.customType, content: prompt.content, details: prompt.details },
	});
	const notes = h.tools.get("notes_write_file")!;
	assert.equal(h.fire("tool_call", {
		type: "tool_call", toolCallId: "failed-note", toolName: "notes_write_file",
		input: { path: "checkpoint", text: "x".repeat(1_000_001) },
	}), undefined);
	await assert.rejects(notes.execute("failed-note", { path: "checkpoint", text: "x".repeat(1_000_001) }, undefined, undefined, h.ctx), /at or below/);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.deepEqual(await reset, { cancel: true });
	assert.equal(h.compactCalls, 0);
	assert.equal(h.coordinationStates.at(-1)?.phase, "checkpoint_required");
	assert.match(h.notifications.at(-1)!, /checkpoint was not saved/);
	assert.equal((h.fire("tool_call", { toolName: "history_list_windows", input: {} }) as { block: boolean }).block, true);

	const retry = h.beginManual();
	const retriedPrompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: retriedPrompt.customType, content: retriedPrompt.content, details: retriedPrompt.details },
	});
	assert.equal(h.fire("tool_call", {
		type: "tool_call", toolCallId: "retried-note", toolName: "notes_write_file",
		input: { path: "checkpoint", text: "saved after retry" },
	}), undefined);
	await notes.execute("retried-note", { path: "checkpoint", text: "saved after retry" }, undefined, undefined, h.ctx);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.ok((await retry).compaction);
	h.cleanup();
}

// Esc during the checkpoint agent turn cancels the user-requested rollover and
// stale checkpoint instructions are removed from later model contexts.
{
	const h = createHarness("manual-checkpoint-esc");
	const controller = new AbortController();
	const reset = h.beginManual(controller.signal);
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
	controller.abort();
	assert.equal(h.abortCalls, 1, "Esc on native compaction also aborts the checkpoint agent");
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
	assert.equal(h.fire("tool_call", { type: "tool_call", toolCallId: "after-esc", toolName: "bash", input: {} }), undefined);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.deepEqual(await reset, { cancel: true });
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
	assert.equal(filtered.messages.some(m => (m as { customType?: string }).customType === CUSTOM_TYPE_MANUAL_CHECKPOINT), false);
	h.cleanup();
}

// Esc after the notes write but before agent_settled keeps the durable note,
// cancels automatic rollover, and permits an explicit retry without rewriting.
{
	const h = createHarness("manual-checkpoint-esc-after-save");
	const controller = new AbortController();
	const reset = h.beginManual(controller.signal);
	const prompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: prompt.customType, content: prompt.content, details: prompt.details },
	});
	h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "saved-then-esc",
		toolName: "notes_write_file",
		input: { path: "checkpoint.md", text: "durable" },
	});
	await h.tools.get("notes_write_file")!.execute(
		"saved-then-esc",
		{ path: "checkpoint.md", text: "durable" },
		undefined,
		undefined,
		h.ctx,
	);
	controller.abort();
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.deepEqual(await reset, { cancel: true });
	assert.equal(h.compactCalls, 0);
	assert.equal(h.coordinationStates.at(-1)?.phase, "rollover_pending");
	assert.ok(h.threshold("manual", 100_000).compaction);
	h.cleanup();
}

// A real compaction failure keeps the successful manual checkpoint reusable;
// an explicit /compact retry does not ask the model to write it again.
{
	const h = createHarness("manual-checkpoint-retry");
	const reset = h.beginManual();
	const prompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: prompt.customType, content: prompt.content, details: prompt.details },
	});
	const notes = h.tools.get("notes_append_to_file")!;
	h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "retry-note",
		toolName: "notes_append_to_file",
		input: { path: "checkpoint.md", text: "saved once" },
	});
	await notes.execute(
		"retry-note",
		{ path: "checkpoint.md", text: "saved once" },
		undefined,
		undefined,
		h.ctx,
	);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	const failedAttempt = await reset;
	assert.ok(failedAttempt.compaction);
	h.failCompact("manual rollover failed", true);
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
	const reset = h.beginManual();
	const prompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: prompt.customType, content: prompt.content, details: prompt.details },
	});
	h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "compact-esc-note",
		toolName: "notes_write_file",
		input: { path: "checkpoint.md", text: "saved before Esc" },
	});
	await h.tools.get("notes_write_file")!.execute(
		"compact-esc-note",
		{ path: "checkpoint.md", text: "saved before Esc" },
		undefined,
		undefined,
		h.ctx,
	);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 0);
	assert.ok((await reset).compaction);
	h.fire("session_compact_failed", {
		type: "session_compact_failed",
		reason: "manual",
		aborted: true,
		willRetry: false,
		fromExtension: true,
	});
	assert.equal(h.coordinationStates.at(-1)?.phase, "rollover_pending");
	h.fire("agent_settled", { type: "agent_settled" });
	assert.equal(h.compactCalls, 0, "Esc must not retry compaction automatically");
	const retry = h.threshold("manual", 100_000);
	assert.ok(retry.compaction, "a later explicit command reuses the saved checkpoint");
	h.cleanup();
}

// Normal user activity after a failed manual rollover invalidates that saved
// checkpoint, reopens tools, and requires a fresh checkpoint on the next command.
{
	const h = createHarness("manual-checkpoint-invalidated");
	const reset = h.beginManual();
	const prompt = h.consumeSteer();
	h.fire("message_end", {
		type: "message_end",
		message: { role: "custom", customType: prompt.customType, content: prompt.content, details: prompt.details },
	});
	h.fire("tool_call", {
		type: "tool_call",
		toolCallId: "invalidate-note",
		toolName: "notes_write_file",
		input: { path: "checkpoint.md", text: "soon stale" },
	});
	await h.tools.get("notes_write_file")!.execute(
		"invalidate-note",
		{ path: "checkpoint.md", text: "soon stale" },
		undefined,
		undefined,
		h.ctx,
	);
	h.setIdle(true);
	h.fire("agent_settled", { type: "agent_settled" });
	assert.ok((await reset).compaction);
	h.failCompact("manual rollover failed", true);
	h.fire("message_end", { type: "message_end", message: { role: "user", content: "new work" } });
	assert.equal(h.coordinationStates.at(-1)?.phase, "ready");
	assert.equal(h.fire("tool_call", { type: "tool_call", toolCallId: "new-work", toolName: "bash", input: {} }), undefined);
	const retried = h.beginManual();
	assert.equal(h.steering.at(-1)?.customType, CUSTOM_TYPE_MANUAL_CHECKPOINT);
	h.fire("message_end", { type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
	h.fire("agent_settled", { type: "agent_settled", aborted: true });
	assert.deepEqual(await retried, { cancel: true });
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


fs.rmSync(agentDir, { recursive: true, force: true });
console.log("integration: all assertions passed");
