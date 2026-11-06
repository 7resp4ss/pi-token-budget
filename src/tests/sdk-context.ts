/** Offline real-Pi SDK acceptance: capture the exact provider context. */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createTokenBudgetExtension, getTokenBudgetTask } from "../api.ts";
import { writeChildExtension } from "../subagents-adapter.ts";
import { TaskRegistry } from "../task-registry.ts";
import { TOOL_SPECS } from "../tools/specs.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-budget-sdk-"));
const oldDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = temp;
const snapshots: unknown[] = [];
const errors: unknown[] = [];
const compactFailures: unknown[] = [];
let nextCalls: Array<{ type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }> = [];
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: "offline", name: "Offline", provider: "budget-offline", api: "openai-completions", baseUrl: "http://offline.invalid", input: ["text", "image"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096 } as const;
const fake: StreamFn = async (_model, context) => {
	snapshots.push(JSON.parse(JSON.stringify(context)));
	const calls = nextCalls; nextCalls = [];
	const message = { role: "assistant", content: calls.length ? calls : [{ type: "text", text: "offline complete" }], usage, api: model.api, model: model.id, provider: model.provider, stopReason: calls.length ? "toolUse" : "stop", timestamp: Date.now() };
	return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, async result() { return message; } } as never;
};

function providerSystemText(snapshot: unknown): string {
	// Pi 0.84 sends systemPrompt separately; Pi 1.5 uses system messages and
	// clears its per-run override after the run. Inspect what the provider got.
	const context = snapshot as { systemPrompt?: string; messages: Array<{ role: string }> };
	return [context.systemPrompt ?? "", ...context.messages.filter(message => message.role === "system").map(message => JSON.stringify(message))].join("\n");
}

async function sdk(name: string, factories: InlineExtension[], additionalExtensionPaths: string[] = [], tools = Object.keys(TOOL_SPECS)) {
	const cwd = path.join(temp, name); fs.mkdirSync(cwd, { recursive: true });
	// Keep enough of a trailing tool result for Pi to find a valid cut point.
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 32 }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd, agentDir: temp, settingsManager, extensionFactories: factories, additionalExtensionPaths,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "FOREIGN_SYSTEM_RULE" });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const runtime = await ModelRuntime.create({ authPath: path.join(temp, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider(model.provider, { apiKey: "offline-fixture", api: model.api, baseUrl: model.baseUrl, models: [{ ...model, input: [...model.input] }] });
	const manager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({ cwd, agentDir: temp, model: { ...model, input: [...model.input] }, modelRuntime: runtime, resourceLoader: loader, sessionManager: manager, settingsManager, tools });
	await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
	session.agent.streamFunction = fake;
	return { session, manager, loader };
}

try {
	let rootAPI: ExtensionAPI | undefined;
	const parent = await sdk("parent-worktree", [{ name: "token-budget", factory: pi => { rootAPI = pi; pi.on("session_compact_failed", event => { compactFailures.push(event); }); createTokenBudgetExtension({ subagents: { enabled: false } })(pi); } }]);
	const parentSnapshot = getTokenBudgetTask(rootAPI!)!;
	assert.equal(parentSnapshot.agentName, "/root");
	await parent.session.prompt("USER_DATA_CANARY");
	assert.equal(snapshots.length, 1, JSON.stringify(parent.session.messages));
	const first = JSON.stringify(snapshots[0]);
	assert.match(first, /FOREIGN_SYSTEM_RULE/);
	assert.match(first, /<pi_token_budget_guidance>/);
	assert.ok(providerSystemText(snapshots[0]).includes("Take incremental notes while you work so you do not miss important info."));
	// Pi 0.84 uses context.tools; Pi 1.5 declares tools on system messages.
	type ProviderTool = { name: string; parameters: unknown };
	const providerContext = snapshots[0] as { tools?: ProviderTool[]; messages: Array<{ role: string; toolsAdded?: ProviderTool[] }> };
	const providerTools = providerContext.tools ?? providerContext.messages.filter(message => message.role === "system").flatMap(message => message.toolsAdded ?? []);
	assert.equal(providerTools.length, 11);
	assert.doesNotMatch(JSON.stringify(providerTools), /"encrypted"\s*:/, "provider-facing tool schemas omit encryption annotations");
	const userId = parent.manager.getBranch().find(e => e.type === "message" && e.message.role === "user")!.id;
	assert.ok(first.includes(`[id: ${userId}]`), "real user ID reaches the provider");
	const originalUser = parent.manager.getBranch().find(e => e.type === "message" && e.message.role === "user");
	assert.ok(originalUser?.type === "message" && originalUser.message.role === "user");
	assert.deepEqual(originalUser.message.content, [{ type: "text", text: "USER_DATA_CANARY" }], "original persisted user entry remains unchanged");
	assert.ok(!providerSystemText(snapshots[0]).includes("USER_DATA_CANARY"), "data never enters system guidance");
	assert.ok(!providerSystemText(snapshots[0]).includes("Current context window id:"));

	nextCalls = [
		{ type: "toolCall", id: "save-notes", name: "notes_write_file", arguments: { path: "checkpoint", text: "TOOL_DATA_CANARY" } },
		{ type: "toolCall", id: "check-budget", name: "get_context_remaining", arguments: {} },
	];
	await parent.session.prompt("TOOL_ROUNDTRIP");
	const toolResults = parent.manager.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult");
	assert.equal(toolResults.length, 2);
	for (const result of toolResults) assert.ok(JSON.stringify(snapshots.at(-1)).includes(`[id: ${result.id}]`), "real tool result ID reaches provider");
	assert.ok(!providerSystemText(snapshots.at(-1)).includes("TOOL_DATA_CANARY"));
	// Real /compact waits for the fenced checkpoint turn and completes the same
	// native attempt, without a cancellation error or a second compaction.
	nextCalls = [{ type: "toolCall", id: "manual-checkpoint", name: "notes_write_file", arguments: { path: "checkpoint", text: "MANUAL_CHECKPOINT_CANARY: no unfinished work" } }];
	const compactEvents: string[] = [];
	const unsubscribe = parent.session.subscribe(event => {
		if (event.type === "compaction_start" || event.type === "compaction_end") compactEvents.push(event.type);
	});
	const compacted = await parent.session.compact();
	await parent.session.waitForIdle();
	unsubscribe();
	assert.deepEqual(compactFailures, [], "successful manual rollover emits no cancellation/failure");
	assert.deepEqual(compactEvents, ["compaction_start", "compaction_end"], "checkpoint and rollover share one native compaction");
	assert.match(compacted.summary, /Current context window id: w2/);
	const noteFiles = compacted.summary.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as { path: string; bytes: number });
	assert.deepEqual(noteFiles.map(file => file.path), ["/root/notes/checkpoint"], "reset lists actual note paths instead of assuming checkpoint.md");
	assert.equal(noteFiles[0].bytes, Buffer.byteLength("MANUAL_CHECKPOINT_CANARY: no unfinished work"));
	assert.ok(!compacted.summary.includes("MANUAL_CHECKPOINT_CANARY"), "bootstrap lists metadata without note bodies");
	assert.match(JSON.stringify(snapshots), /context_window_checkpoint/);
	assert.ok(parent.manager.getBranch().some(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "manual-checkpoint"));
	nextCalls = [{ type: "toolCall", id: "recover-checkpoint", name: "notes_read_file", arguments: { path: noteFiles[0].path } }];
	const recoveryStart = snapshots.length;
	await parent.session.prompt("AFTER_RESET");
	assert.match(JSON.stringify(snapshots.at(-1)), /Current context window id: w2/);
	const beforeRecovery = JSON.stringify(snapshots[recoveryStart]);
	assert.ok(beforeRecovery.includes("Existing notes for /root") && beforeRecovery.includes("/root/notes/checkpoint"), "reset notes index reaches the provider before any recovery tool call");
	assert.ok(!beforeRecovery.includes("MANUAL_CHECKPOINT_CANARY"), "note bodies require an explicit recovery read");
	assert.ok(!providerSystemText(snapshots.at(-1)).includes("/root/notes/checkpoint"), "note metadata stays outside system guidance");
	const restored = parent.manager.getBranch().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "recover-checkpoint");
	assert.match(JSON.stringify(restored), /MANUAL_CHECKPOINT_CANARY/, "listed path restores the checkpoint through the real SDK tool");
	const lastContext = snapshots.at(-1) as { messages: unknown[] };
	assert.ok(!JSON.stringify(lastContext.messages).includes('"text":"TOOL_ROUNDTRIP"'), "old raw conversation is discarded");

	const task = new TaskRegistry({ sessionDir: parent.manager.getSessionDir(), sessionId: parent.manager.getSessionId() });
	const generated = writeChildExtension(task);
	const exited = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./sdk-child.ts", import.meta.url)), generated, path.join(temp, "detached-worktree")]);
	const background = JSON.parse(exited.stdout.trim());
	assert.equal(background.context.runId, parentSnapshot.context.runId);
	nextCalls = [{ type: "toolCall", id: "read-background", name: "history_read_item", arguments: { agent_name: background.agentName, window_id: "w1", item_id: background.itemId } }];
	await parent.session.prompt("RECOVER_DETACHED_IMAGE");
	const lastResult = parent.manager.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult").at(-1)!;
	assert.ok(lastResult.type === "message" && lastResult.message.role === "toolResult" && Array.isArray(lastResult.message.content) && lastResult.message.content.some(c => c.type === "image" && c.data === "aGVsbG8="), "image survives a detached SDK process exit");

	let childAPI: ExtensionAPI | undefined;
	const child = await sdk("child-other-worktree", [{ name: "ambient-token-budget", factory: pi => { childAPI = pi; createTokenBudgetExtension({ subagents: { enabled: false } })(pi); } }], [generated]);
	const childSnapshot = getTokenBudgetTask(childAPI!)!;
	assert.equal(childSnapshot.context.runId, parentSnapshot.context.runId);
	assert.notEqual(childSnapshot.agentName, parentSnapshot.agentName);
	assert.equal(child.session.getAllTools().filter(t => t.name in TOOL_SPECS).length, 11, "ambient + generated load has one tool/state instance");
	await child.session.prompt("CHILD_CANARY");
	assert.match(JSON.stringify(snapshots.at(-1)), new RegExp(childSnapshot.agentName));
	assert.deepEqual(errors, []);
	const restricted = await sdk("restricted", [{ name: "restricted-budget", factory: createTokenBudgetExtension({ subagents: { enabled: false } }) }], [], ["get_context_remaining"]);
	assert.deepEqual(restricted.session.getActiveToolNames(), ["get_context_remaining"], "extension must not expand a tool whitelist");
	await restricted.session.prompt("restricted request");
	assert.deepEqual(restricted.session.getActiveToolNames(), ["get_context_remaining"]);
	parent.session.dispose(); child.session.dispose(); restricted.session.dispose();
	console.log("SDK context: manual checkpoint rollover, reset notes discovery and recovery, system guidance, real item markers, immutable originals, memory sessions, detached process images, worktree sharing, duplicate loading, and whitelist passed");
} finally {
	if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
	fs.rmSync(temp, { recursive: true, force: true });
}
