/** Acceptance tests for the eleven-function surface and shared recovery data. */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTokenBudgetExtension, getTokenBudgetTask, TaskRegistry, resolveAgentName, type TaskContext } from "../api.ts";
import { DEFAULTS } from "../config.ts";
import { NotesStore } from "../stores/notes-store.ts";
import { HistoryStore, type LooseEntry } from "../stores/history-store.ts";
import { HistoryJournal, type JournalEntry } from "../stores/history-journal.ts";
import { CUSTOM_TYPE_CONTEXT_WINDOW, CUSTOM_TYPE_FALLBACK, bootstrapText, SYSTEM_GUIDANCE_MARKER, injectSystemGuidance } from "../prompts.ts";
import { TOOL_SPECS } from "../tools/specs.ts";
import { charLength, withFileLock } from "../storage.ts";

const exec = promisify(execFile);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-budget-recovery-"));
const previousEnv = process.env.PI_AGENT_DIR;
process.env.PI_AGENT_DIR = temp;
interface Tool { name: string; description: string; executionMode: string; parameters: object; execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<Result> }
interface Result { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; terminate?: boolean; details?: { offset: number; end: number; totalChars: number } }
const textOf = (r: Result): string => r.content.filter(c => c.type === "text").map(c => c.text).join("\n");
const rowsOf = (r: Result) => textOf(r).split("\n").slice(1).filter(s => s.startsWith("{")).map(s => JSON.parse(s));

async function harness(id: string, options: { task?: TaskContext; branch?: LooseEntry[]; duplicate?: boolean; sessionDir?: string } = {}) {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const branch = options.branch ?? [];
	const directory = options.sessionDir ?? path.join(temp, id);
	const warnings: string[] = [];
	const events = {
		on(channel: string, callback: (data: unknown) => void) { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(callback); return () => { listeners.get(channel)?.delete(callback); }; },
		emit(channel: string, data: unknown) { for (const cb of listeners.get(channel) ?? []) cb(data); },
	};
	const ctx = {
		sessionManager: { getSessionDir: () => directory, getSessionId: () => id, getSessionFile: () => undefined, getBranch: () => branch },
		getContextUsage: () => ({ tokens: 10, contextWindow: 100_000 }),
		isIdle: () => false,
		ui: { notify: (message: string) => warnings.push(message) },
		model: { input: ["text", "image"] },
	} as unknown as ExtensionContext;
	const pi = {
		registerTool(t: Tool) { assert.ok(!tools.has(t.name), `duplicate registration ${t.name}`); tools.set(t.name, t); },
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		events,
		getAllTools: () => [],
		getActiveTools: () => [...tools.keys()],
		sendMessage(m: Record<string, unknown>, opts: { triggerTurn?: boolean }) { if (!opts?.triggerTurn) branch.push({ id: `custom-${branch.length}`, type: "custom_message", ...m }); },
	} as unknown as ExtensionAPI;
	const fire = async (event: string, payload: unknown = {}) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(payload as never, ctx) ?? result;
		return result;
	};
	if (options.duplicate) createTokenBudgetExtension({ subagents: { enabled: false } })(pi);
	createTokenBudgetExtension({ task: options.task, subagents: { enabled: false } })(pi);
	if (options.duplicate) createTokenBudgetExtension({ task: options.task })(pi);
	await fire("session_start");
	return { pi, ctx, tools, branch, directory, fire, warnings, snapshot: getTokenBudgetTask(pi)!, call: (name: string, params: unknown = {}) => tools.get(name)!.execute("test", params, undefined, undefined, ctx) };
}

try {
	const root = await harness("root", { duplicate: true });
	assert.equal(root.tools.size, 11);
	assert.ok(!root.tools.has("notes") && !root.tools.has("history"));
	const reference = JSON.parse(fs.readFileSync(new URL("./fixtures/codex-tools.json", import.meta.url), "utf8"));
	for (const frozen of reference.tools) {
		const name = frozen.name.replace(/^functions\./, "").replaceAll(".", "_");
		const tool = root.tools.get(name)!;
		assert.equal(tool.description, frozen.description, name);
		assert.equal(tool.executionMode, frozen.parallel ? "parallel" : "sequential", name);
		const schema = structuredClone(tool.parameters) as { properties: Record<string, unknown> };
		if (name === "notes_read_file") { delete schema.properties.offset_chars; delete schema.properties.limit_chars; }
		const expected = structuredClone(frozen.parameters);
		const plaintextField = name === "notes_write_file" || name === "notes_append_to_file" ? "text"
			: name === "notes_search_contents" || name === "history_search_contents" ? "query" : undefined;
		if (plaintextField) {
			assert.equal(expected.properties[plaintextField].encrypted, true, `${name} reference annotation`);
			delete expected.properties[plaintextField].encrypted;
		}
		assert.doesNotMatch(JSON.stringify(tool.parameters), /"encrypted"\s*:/, `${name} must not request encrypted arguments`);
		assert.deepEqual(schema, expected, name);
	}
	await assert.rejects(root.call("history_read_item", { item_id: "missing" }), /Invalid parameters/);
	await assert.rejects(root.call("notes_write_file", { path: "missing-text" }), /Invalid parameters/);
	await assert.rejects(root.call("notes_list_files_by_prefix", { file_order: "newest" }), /Invalid parameters/);
	await assert.rejects(root.call("history_list_items", { role: "toolResult" }), /Invalid parameters/);
	await assert.rejects(root.call("history_list_windows", { limit: 0 }), /Invalid parameters/);
	await assert.rejects(root.call("history_list_windows", { recent_first: "true" }), /Invalid parameters/);
	await root.call("notes_write_file", { path: "empty", text: "" });
	await root.call("notes_append_to_file", { path: "empty", text: "" });
	assert.equal(textOf(await root.call("notes_read_file", { path: "empty" })).split("\n").slice(1).join("\n"), "");

	const child = await harness("child", { task: { ...root.snapshot.context, parentAgentName: "/root", agentName: "child" }, duplicate: true });
	const sibling = await harness("sibling", { task: { ...root.snapshot.context, parentAgentName: "/root", agentName: "sibling" } });
	const grandchild = await harness("grandchild", { task: { ...root.snapshot.context, parentAgentName: "/root/child", agentName: "leaf" } });
	const unrelated = await harness("unrelated", { sessionDir: root.directory });
	assert.equal(grandchild.snapshot.agentName, "/root/child/leaf");
	assert.equal(resolveAgentName("/root/child", "leaf"), "/root/child/leaf");
	assert.throws(() => resolveAgentName("/root/child", "../sibling"), /Invalid agent/);
	assert.throws(() => resolveAgentName("/root", "/root/UPPER"), /Invalid agent/);
	assert.equal(new TaskRegistry({ sessionDir: root.directory, sessionId: "root" }).context.runId, root.snapshot.context.runId, "resume reuses task identity");
	assert.notEqual(unrelated.snapshot.context.runId, root.snapshot.context.runId, "same directory does not join unrelated sessions");
	await root.call("notes_write_file", { path: "/root/child/notes/state", text: "parent-created" });
	await sibling.call("notes_append_to_file", { path: "/root/child/notes/state", text: " sibling-appended" });
	assert.match(textOf(await grandchild.call("notes_read_file", { path: "/root/child/notes/state" })), /parent-created sibling-appended/);
	await assert.rejects(unrelated.call("notes_read_file", { path: "/root/child/notes/state" }), /not registered/);
	await assert.rejects(root.call("history_list_windows", { agent_name: "missing" }), /not registered/);
	await assert.rejects(root.call("notes_write_file", { path: "../escape", text: "x" }), /not allowed|escapes/);
	await assert.rejects(root.call("notes_write_file", { path: "/root/notes/x//y", text: "x" }), /not allowed/);

	// Child data is rooted in the task, not in a disposable worktree/session dir.
	const disposable = path.join(temp, "disposable-worktree");
	const worktreeChild = await harness("worktree-child", { sessionDir: disposable, task: { ...root.snapshot.context, parentAgentName: "/root", agentName: "worktree_child" } });
	await worktreeChild.call("notes_write_file", { path: "keep", text: "survives worktree removal" });
	fs.rmSync(disposable, { recursive: true, force: true });
	assert.match(textOf(await root.call("notes_read_file", { path: "/root/worktree_child/notes/keep" })), /survives worktree removal/);
	const legacyDirectory = path.join(temp, "legacy-child");
	new NotesStore(legacyDirectory, "legacy-child", 1_000_000).writeFile("before", "existing legacy checkpoint");
	const legacy = await harness("legacy-child", { sessionDir: legacyDirectory, task: { ...root.snapshot.context, parentAgentName: "/root", agentName: "legacy" } });
	assert.match(textOf(await root.call("notes_read_file", { path: "/root/legacy/notes/before" })), /existing legacy checkpoint/);
	assert.equal(new TaskRegistry({ sessionDir: legacyDirectory, sessionId: "legacy-child" }).agent.notesRoot, path.join(legacyDirectory, "pi-token-budget", "notes", "legacy-child"));

	// A lexical prefix need not be a directory; creation sorting survives overwrite.
	await root.call("notes_write_file", { path: "order/z-old", text: "needle old" });
	await delay(5);
	await root.call("notes_write_file", { path: "order/a-new", text: "needle new" });
	const before = rowsOf(await root.call("notes_list_files_by_prefix", { prefix: "order/z-" }));
	assert.equal(before.length, 1);
	await delay(5);
	await root.call("notes_write_file", { path: "order/z-old", text: "needle overwritten" });
	const after = rowsOf(await root.call("notes_list_files_by_prefix", { prefix: "order/z-" }));
	assert.equal(before[0].created_at, after[0].created_at);
	assert.match(textOf(await root.call("notes_search_contents", { query: "needle", path_prefix: "order", recent_file_first: true, max_files: 1 })), /order\/a-new/);
	assert.deepEqual(rowsOf(await root.call("notes_list_files_by_prefix", { prefix: "order", file_order_by: "updated_at", file_order: "descending" })).map(r => r.path), ["/root/notes/order/z-old", "/root/notes/order/a-new"]);

	// Full multi-page reconstruction, including astral characters and selected lines.
	const original = "🙂𐐷汉".repeat(12_000);
	await root.call("notes_write_file", { path: "long", text: original });
	let rebuilt = "";
	for (let offset = 0; offset < charLength(original);) {
		const result = await root.call("notes_read_file", { path: "long", offset_chars: offset, limit_chars: 100_000 });
		const page = textOf(result).split("\n").slice(1).join("\n");
		assert.equal(charLength(page), result.details!.end - result.details!.offset);
		assert.ok(charLength(textOf(result)) <= DEFAULTS.maxToolOutputChars);
		assert.ok(result.details!.end > offset);
		rebuilt += page; offset = result.details!.end;
	}
	assert.equal(rebuilt, original);
	await root.call("notes_write_file", { path: "lines", text: "one\n🙂two\nthree" });
	assert.match(textOf(await root.call("notes_read_file", { path: "lines", start_line: -2, stop_line: -2, offset_chars: 1, limit_chars: 3 })), /\ntwo$/);
	const tiny = new NotesStore(temp, "utf8", 4);
	tiny.writeFile("emoji", "🙂");
	assert.throws(() => tiny.appendToFile("emoji", "x"), /at or below/);

	// Pair filters must match one callable, not the namespace of one and name of another.
	const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
	const historyBranch: LooseEntry[] = [
		{ id: "u-image", type: "message", message: { role: "user", content: [{ type: "text", text: original }, image], timestamp: 42 } },
		{ id: "a-call", type: "message", message: { role: "assistant", content: [
			{ type: "toolCall", id: "call-a", name: "alpha.foo", arguments: {} },
			{ type: "toolCall", id: "call-b", name: "beta.bar", arguments: {} },
		] } },
		{ id: "t-image", type: "message", message: { role: "toolResult", toolCallId: "call-a", content: [image, { type: "text", text: "image tool result" }] } },
		{ id: "reset", type: "compaction", summary: bootstrapText({ firstWindowId: "w1", previousWindowId: "w1", currentWindowId: "w2", windowNumber: 2 }) },
		{ id: "new-user", type: "message", message: { role: "user", content: "second window" } },
	];
	root.branch.push(...historyBranch);
	assert.equal(rowsOf(await root.call("history_list_items", { tool_namespace: "alpha", tool_name: "bar" })).length, 0);
	assert.deepEqual(rowsOf(await root.call("history_list_items", { tool_namespace: "alpha", tool_name: "foo", role: "tool" })).map(r => r.item_id), ["t-image"]);
	assert.equal(rowsOf(await root.call("history_list_items", { window_id: "bogus" })).length, 0);
	assert.equal(rowsOf(await root.call("history_list_items", { window_id: "" })).length, 0);
	assert.equal(rowsOf(await root.call("history_search_contents", { query: "second", window_id: "bogus" })).length, 0);
	await assert.rejects(root.call("history_read_item", { item_id: "u-image", window_id: "w2" }), /no history item/);
	const list = rowsOf(await root.call("history_list_items", { window_id: "w1", max_chars_per_item: 5 }));
	assert.ok(list.every(r => charLength(r.truncated_content) <= 5));
	assert.equal(list.find(r => r.item_id === "u-image")?.image_count, 1);
	assert.match(textOf(await root.call("history_list_windows", { limit: 1, recent_first: true })), /w2:/);
	const recovered = await sibling.call("history_read_item", { agent_name: "/root", window_id: "w1", item_id: "t-image" });
	assert.deepEqual(recovered.content.filter(c => c.type === "image"), [image]);
	rebuilt = "";
	const historyText = new HistoryStore(historyBranch).readItem("u-image", 0, 1_000_000, "w1").text;
	for (let offset = 0; offset < charLength(historyText);) {
		const result = await root.call("history_read_item", { window_id: "w1", item_id: "u-image", offset_chars: offset, limit_chars: 100_000 });
		const page = textOf(result).split("\n").slice(1).join("\n");
		assert.equal(charLength(page), result.details!.end - result.details!.offset);
		assert.ok(charLength(textOf(result)) <= DEFAULTS.maxToolOutputChars);
		rebuilt += page; offset = result.details!.end;
	}
	assert.equal(rebuilt, historyText);
	(root.ctx.model!.input as string[]) = ["text"];
	const textOnly = await root.call("history_read_item", { item_id: "u-image", window_id: "w1" });
	assert.ok(textOnly.content.every(c => c.type !== "image"));
	assert.match(textOf(textOnly), /text only/);

	// History committed by an exited process is recoverable without touching its session file.
	const worker = fileURLToPath(new URL("./recovery-worker.ts", import.meta.url));
	const historyFixture = path.join(temp, "worker-history.json");
	fs.writeFileSync(historyFixture, JSON.stringify({ task: { ...root.snapshot.context, parentAgentName: "/root", agentName: "exited" }, branch: historyBranch }));
	const exited = await exec(process.execPath, ["--experimental-strip-types", worker, "history", path.join(temp, "exited"), historyFixture]);
	assert.equal(exited.stdout.trim(), "/root/exited");
	const postExit = await child.call("history_read_item", { agent_name: "/root/exited", item_id: "u-image", window_id: "w1", limit_chars: 2 });
	assert.deepEqual(postExit.content.filter(c => c.type === "image"), [image]);
	const registry = new TaskRegistry({ sessionDir: root.directory, sessionId: "root" });
	assert.ok(new HistoryJournal(registry.resolve("exited")).readBranch().length > 0);

	// The checkpoint fence permits own notes only, with retries on failed writes.
	await child.fire("message_end", { message: { role: "custom", customType: CUSTOM_TYPE_FALLBACK, details: { windowId: "w1", kind: "fallback" } } });
	for (const toolName of Object.keys(TOOL_SPECS).filter(t => t !== "notes_write_file" && t !== "notes_append_to_file")) {
		assert.equal((await child.fire("tool_call", { toolName, input: {} }) as { block: boolean }).block, true, toolName);
	}
	assert.equal((await child.fire("tool_call", { toolName: "notes_write_file", input: { path: "/root/notes/foreign", text: "wrong" } }) as { block: boolean }).block, true);
	assert.equal(await child.fire("tool_call", { toolName: "notes_write_file", input: { path: "checkpoint", text: "x".repeat(1_000_001) } }), undefined);
	await assert.rejects(child.call("notes_write_file", { path: "checkpoint", text: "x".repeat(1_000_001) }), /at or below/);
	assert.equal(await child.fire("tool_call", { toolName: "notes_write_file", input: { path: "checkpoint", text: "saved" } }), undefined);
	assert.equal((await child.call("notes_write_file", { path: "checkpoint", text: "saved" })).terminate, true);
	assert.equal((await child.fire("tool_call", { toolName: "notes_append_to_file", input: { path: "checkpoint", text: "late" } }) as { block: boolean }).block, true);

	// Static system guidance chains and deduplicates; recovered data stays out.
	const system = await root.fire("before_agent_start", { systemPrompt: "FOREIGN_SYSTEM_RULE" }) as { systemPrompt: string };
	assert.ok(system.systemPrompt.startsWith("FOREIGN_SYSTEM_RULE"));
	assert.equal(injectSystemGuidance(system.systemPrompt), system.systemPrompt);
	assert.equal(system.systemPrompt.split(SYSTEM_GUIDANCE_MARKER).length - 1, 1);
	assert.ok(!system.systemPrompt.includes("parent-created"));
	assert.ok(!system.systemPrompt.includes("Current context window id:"));
	const userMessage = (historyBranch[0].message as Record<string, unknown>);
	const context = await root.fire("context", { messages: [userMessage] }) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
	assert.match(JSON.stringify(context.messages), /\[id: u-image\]/);
	assert.ok(!JSON.stringify(userMessage).includes("[id:"), "projection must not mutate original");
	assert.match(JSON.stringify(context.messages[0]), /Agent name: \/root/);
	await root.fire("session_compact", { compactionEntry: { summary: "unrelated native compaction" } });
	assert.ok(!system.systemPrompt.includes("🙂"));

	// Concurrent process writers preserve all appends and the byte cap.
	await Promise.all(Array.from({ length: 4 }, (_, i) => exec(process.execPath, ["--experimental-strip-types", worker, "append", temp, JSON.stringify({ worker: i, count: 40 })])));
	const concurrent = new NotesStore(temp, "concurrent", 1_000_000);
	const lines = concurrent.readFile("log").content.trim().split("\n");
	assert.equal(lines.length, 160); assert.equal(new Set(lines).size, 160);
	const cappedDir = path.join(temp, "capped");
	await Promise.all(Array.from({ length: 3 }, (_, i) => exec(process.execPath, ["--experimental-strip-types", worker, "append", cappedDir, JSON.stringify({ worker: i, count: 30, cap: 100 })])));
	assert.ok(Buffer.byteLength(new NotesStore(cappedDir, "concurrent", 100).readFile("log").content) <= 100);
	// A dead process cannot permanently strand a checkpoint lock.
	const abandoned = path.join(temp, "abandoned");
	fs.mkdirSync(`${abandoned}.lock`);
	fs.writeFileSync(path.join(`${abandoned}.lock`, "owner"), "999999999");
	assert.equal(withFileLock(abandoned, () => "recovered"), "recovered");
	assert.ok(!fs.existsSync(`${abandoned}.lock`));

	console.log("recovery acceptance: eleven Codex definitions, task isolation/sharing, filters/sorts, Unicode paging, images, fence, prompts, and concurrent processes passed");
} finally {
	if (previousEnv === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previousEnv;
	fs.rmSync(temp, { recursive: true, force: true });
}
