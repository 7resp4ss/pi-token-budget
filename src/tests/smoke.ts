/**
 * Smoke test for the pure modules (no pi runtime needed).
 * Run: npm run smoke  (compiles to .smoke/ and executes with node)
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULTS, loadConfig, reminderThreshold, resolveForModel, type ConfigBundle } from "../config.ts";
import { HistoryStore } from "../stores/history-store.ts";
import { NotesStore } from "../stores/notes-store.ts";
import {
	BOOTSTRAP_MARKER,
	NEW_CONTEXT_CONFIRMATION,
	bootstrapText,
	guidanceMessage,
	manualCheckpointMessage,
	newContextConfirmation,
	reminderMessage,
} from "../prompts.ts";
import { notesBloatWarnings } from "../tools/deps.ts";
import { commitRollover, freshState, inferFromBranch, loadState, saveState, stateFilePath } from "../state.ts";

// --- config thresholds ---------------------------------------------------
assert.equal(reminderThreshold(DEFAULTS, 200_000), 50_000); // 25% of window
assert.equal(reminderThreshold(DEFAULTS, 128_000), 32_000);
assert.equal(reminderThreshold(DEFAULTS, 32_000), 16_000); // 50% clamp wins; small windows degrade to fallback-first
assert.equal(reminderThreshold(DEFAULTS, 16_000), 8_000); // clamped to 50% of window
assert.ok(reminderThreshold(DEFAULTS, 200_000) < 200_000 - 16_384, "reminder must fire before pi auto-compact");

// --- per-model config resolution ------------------------------------------
const bundle: ConfigBundle = {
	defaults: { ...DEFAULTS, hardRolloverUsedTokens: 0 },
	models: {
		"openai/gpt-5.6-codex": { hardRolloverUsedTokens: 256_000 },
		"anthropic/*": { hardRolloverUsedTokens: 160_000, reminderRemainingPercent: 0.3 },
		anthropic: { hardRolloverUsedTokens: 120_000 },
	"*": { maxToolOutputChars: 8000 }, // global-only field is ignored for model resolution
	},
};
assert.equal(resolveForModel(bundle, "openai", "gpt-5.6-codex").hardRolloverUsedTokens, 256_000); // exact wins
assert.equal(resolveForModel(bundle, "anthropic", "claude-opus-4").hardRolloverUsedTokens, 160_000); // provider/* beats bare provider
assert.equal(resolveForModel(bundle, "anthropic", "claude-opus-4").reminderRemainingPercent, 0.3);
assert.equal(resolveForModel(bundle, "google", "gemini-2.5-pro").maxToolOutputChars, DEFAULTS.maxToolOutputChars); // global-only field stays global
assert.equal(resolveForModel(bundle, "google", "gemini-2.5-pro").hardRolloverUsedTokens, 0); // untouched keys inherit defaults
assert.deepEqual(resolveForModel(bundle, undefined, undefined), bundle.defaults); // no model: defaults

// --- state machine --------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-token-budget-smoke-"));
let st = freshState("s1");
assert.equal(st.windowNumber, 1);
assert.equal(st.previousWindowId, null);
assert.equal(st.currentWindowId, "w1", "window id is the ordinal");
st = { ...st, pendingNewContext: true, reminderDelivered: true, fallbackDelivered: true, fallbackActive: true };
st = commitRollover(st, { id: "w2", number: 2 });
assert.equal(st.windowNumber, 2);
assert.equal(st.currentWindowId, "w2");
assert.equal(st.reminderDelivered, false, "one-shot flags reset per window");
assert.equal(st.pendingNewContext, false);
assert.equal(st.fallbackActive, false);
saveState(dir, st);
assert.deepEqual(loadState(dir, "s1").currentWindowId, "w2");

// Invalid persisted state is rejected so branch inference can rebuild it.
fs.writeFileSync(
	stateFilePath(dir, "s1"),
	JSON.stringify({ ...st, currentWindowId: "w3", windowNumber: 2 }),
	"utf8",
);
assert.equal(loadState(dir, "s1").currentWindowId, "w1");
const recovered = inferFromBranch(loadState(dir, "s1"), [
	{ type: "compaction", summary: `rollover ${BOOTSTRAP_MARKER}` },
]);
assert.equal(recovered.currentWindowId, "w2");
fs.writeFileSync(
	stateFilePath(dir, "s1"),
	JSON.stringify({ ...freshState("s1"), reminderDelivered: "yes" }),
	"utf8",
);
assert.equal(loadState(dir, "s1").currentWindowId, "w1");

// inference after state loss
const st2 = inferFromBranch(freshState("s1"), [
	{ type: "message" },
	{ type: "compaction", summary: `stuff ${BOOTSTRAP_MARKER} more` },
	{ type: "message" },
	{ type: "compaction", summary: `${BOOTSTRAP_MARKER}` },
	{ type: "message" },
]);
assert.equal(st2.windowNumber, 3);
assert.equal(st2.currentWindowId, "w3");
assert.equal(st2.previousWindowId, "w2");
assert.equal(st2.reminderDelivered, true, "conservative after inference");

// Environment overrides are global and win over model-specific trigger values.
const previousPercent = process.env.PI_TOKEN_BUDGET_REMINDER_PERCENT;
const previousHard = process.env.PI_TOKEN_BUDGET_HARD_ROLLOVER_TOKENS;
process.env.PI_TOKEN_BUDGET_REMINDER_PERCENT = "0.2";
process.env.PI_TOKEN_BUDGET_HARD_ROLLOVER_TOKENS = "999";
const envResolved = resolveForModel(bundle, "anthropic", "claude-opus-4");
assert.equal(envResolved.reminderRemainingPercent, 0.2);
assert.equal(envResolved.hardRolloverUsedTokens, 999);
if (previousPercent === undefined) delete process.env.PI_TOKEN_BUDGET_REMINDER_PERCENT;
else process.env.PI_TOKEN_BUDGET_REMINDER_PERCENT = previousPercent;
if (previousHard === undefined) delete process.env.PI_TOKEN_BUDGET_HARD_ROLLOVER_TOKENS;
else process.env.PI_TOKEN_BUDGET_HARD_ROLLOVER_TOKENS = previousHard;

const previousInvalidPercent = process.env.PI_TOKEN_BUDGET_REMINDER_PERCENT;
const previousInvalidAgentDir = process.env.PI_AGENT_DIR;
const invalidEnvAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-token-budget-env-config-"));
process.env.PI_AGENT_DIR = invalidEnvAgentDir;
process.env.PI_TOKEN_BUDGET_REMINDER_PERCENT = "1.2";
let invalidEnvWarningCount = 0;
const warnBeforeInvalidEnv = console.warn;
console.warn = () => {
	invalidEnvWarningCount++;
};
const invalidEnvConfig = loadConfig();
console.warn = warnBeforeInvalidEnv;
assert.equal(invalidEnvConfig.defaults.reminderRemainingPercent, DEFAULTS.reminderRemainingPercent);
assert.equal(invalidEnvWarningCount, 1);
if (previousInvalidPercent === undefined) delete process.env.PI_TOKEN_BUDGET_REMINDER_PERCENT;
else process.env.PI_TOKEN_BUDGET_REMINDER_PERCENT = previousInvalidPercent;
if (previousInvalidAgentDir === undefined) delete process.env.PI_AGENT_DIR;
else process.env.PI_AGENT_DIR = previousInvalidAgentDir;
fs.rmSync(invalidEnvAgentDir, { recursive: true, force: true });

// Settings use the same bounds as environment overrides and warn once.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-token-budget-config-"));
const previousAgentDir = process.env.PI_AGENT_DIR;
const previousCodingAgentDirForSettings = process.env.PI_CODING_AGENT_DIR;
process.env.PI_AGENT_DIR = configDir;
process.env.PI_CODING_AGENT_DIR = configDir;
fs.writeFileSync(
	path.join(configDir, "settings.json"),
	JSON.stringify({
		tokenBudget: {
			defaults: {
				reminderRemainingPercent: 1,
				maxToolOutputChars: 0,
				notesMaxFileBytes: 0,
				historyItemPreviewChars: 0,
			},
		},
	}),
	"utf8",
);
const originalWarn = console.warn;
let configWarningCount = 0;
console.warn = () => {
	configWarningCount++;
};
const invalidConfig = loadConfig();
console.warn = originalWarn;
assert.equal(invalidConfig.defaults.reminderRemainingPercent, DEFAULTS.reminderRemainingPercent);
assert.equal(invalidConfig.defaults.maxToolOutputChars, DEFAULTS.maxToolOutputChars);
assert.equal(invalidConfig.defaults.notesMaxFileBytes, DEFAULTS.notesMaxFileBytes);
assert.equal(invalidConfig.defaults.historyItemPreviewChars, DEFAULTS.historyItemPreviewChars);
assert.equal(configWarningCount, 1);
if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
else process.env.PI_AGENT_DIR = previousAgentDir;
if (previousCodingAgentDirForSettings === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDirForSettings;
fs.rmSync(configDir, { recursive: true, force: true });

// --- prompts ----------------------------------------------------------------
const boot = bootstrapText({ firstWindowId: "w-a", previousWindowId: "w-b", currentWindowId: "w-c", windowNumber: 3 });
assert.ok(boot.includes(BOOTSTRAP_MARKER));
assert.ok(boot.includes("Current context window id: w-c"));
assert.ok(boot.includes("Previous context window id: w-b"));
assert.ok(boot.toLowerCase().includes("not a conversation summary"));
assert.ok(!boot.includes("User requests from this session"), "empty index omits the section");
const bootWithReqs = bootstrapText({ firstWindowId: "w-a", previousWindowId: "w-b", currentWindowId: "w-c", windowNumber: 4 }, [
	"u1 — please ship the plugin",
	"u2 — also add tests",
]);
assert.ok(bootWithReqs.includes("User requests from this session"));
assert.ok(bootWithReqs.includes("u1 — please ship the plugin"));
assert.ok(bootWithReqs.includes("u2 — also add tests"));
assert.ok(!boot.includes("Files edited in this session"), "empty file index omits the section");
const bootWithFiles = bootstrapText(
	{ firstWindowId: "w-a", previousWindowId: "w-b", currentWindowId: "w-c", windowNumber: 5 },
	["u1 — please ship the plugin"],
	['src/auth.ts (last edit: e17)', '(2 other file(s) also edited — call history with {"operation":"search_contents","query":"[tool_call edit]","kind":"tool_call"})'],
);
assert.ok(bootWithFiles.includes("Files edited in this session"));
assert.ok(bootWithFiles.includes("src/auth.ts (last edit: e17)"));
assert.ok(bootWithFiles.includes("2 other file(s) also edited"));
const firstWindowGuidance = guidanceMessage({ firstWindowId: "w-a", previousWindowId: null, currentWindowId: "w-c", windowNumber: 1 });
assert.ok(firstWindowGuidance.includes("verbatim"), "guidance requires verbatim quotes");
assert.doesNotMatch(firstWindowGuidance, /pi-token-budget|token-budget/i, "model guidance stays product-agnostic");
assert.doesNotMatch(firstWindowGuidance, /list_windows|list_items|search_contents|read_item/, "operation guidance belongs to the history tool schema");
assert.ok(!boot.includes("Recovery protocol:"), "bootstrap recovery is a hint, not a task checklist");
assert.ok(reminderMessage("w-c", 1234).includes("verbatim"), "reminder requires verbatim quotes");
assert.ok(reminderMessage("w-c", 1234).includes("only 1234 tokens remain"));
assert.ok(reminderMessage("w-c", 1234).includes('source_context_window_id="w-c"'));
assert.ok(reminderMessage("w-c", 1234).includes("clean up old notes"), "generic cleanup advice when no bloat");
const manualCheckpoint = manualCheckpointMessage("w-c", ["u1 — user — finish the parser"]);
assert.match(manualCheckpoint, /user requested a fresh context window/i);
assert.match(manualCheckpoint, /exactly one notes write or append/i);
assert.match(manualCheckpoint, /Do not call new_context/);
assert.match(manualCheckpoint, /u1 — user — finish the parser/);
assert.doesNotMatch(manualCheckpoint, /nearly exhausted|pi-token-budget|token-budget/i);

// The new_context confirmation carries the recent-item index in the OLD window
// and degrades to the plain sentence when the branch has nothing to index.
assert.equal(newContextConfirmation([]), NEW_CONTEXT_CONFIRMATION, "empty index adds no text");
const ncText = newContextConfirmation(["a1 — user — fix the parser panic", "b2 — assistant — [tool_call edit] {\"path\":\"src/p.ts\"}"]);
assert.ok(ncText.startsWith(NEW_CONTEXT_CONFIRMATION), "base confirmation is preserved");
assert.ok(ncText.includes("a1 — user — fix the parser panic"), "ids are copyable from the tool result");
assert.ok(ncText.includes("b2 — assistant — [tool_call edit]"), "tool-call anchors are included");
assert.ok(ncText.includes("NOT carried into the new window"), "states plainly that this text does not cross the boundary");
assert.ok(!NEW_CONTEXT_CONFIRMATION.includes("Recent items"), "the plain confirmation carries no index");
const bloatedReminder = reminderMessage("w-c", 1234, [], ['⚠ note "chonky.md" is 80000 bytes (> 62500)']);
assert.ok(bloatedReminder.includes("Notes bloat"));
assert.ok(bloatedReminder.includes("chonky.md"));
assert.ok(!bloatedReminder.includes("clean up old notes"), "quantified warnings replace the generic advice");
assert.ok(boot.includes("stale queue remnant"));

// --- notes -------------------------------------------------------------------
const notes = new NotesStore(dir, "notes-session-a", 1_000_000);
notes.writeFile("checkpoint.md", "goal: ship the plugin\n");
notes.appendToFile("checkpoint.md", "progress: smoke test\n");
assert.equal(notes.readFile("checkpoint.md").content, "goal: ship the plugin\nprogress: smoke test\n");

// max_files limits matching files, not the number of matching lines.
const notesLimit = new NotesStore(dir, "notes-search-limit", 1_000_000);
notesLimit.writeFile("many-matches.md", "smoke\nsmoke\nsmoke\n");
notesLimit.writeFile("second-match.md", "smoke\n");
assert.deepEqual(
	notesLimit.searchContents("smoke", undefined, 2, 10).map((match) => match.path),
	["many-matches.md", "many-matches.md", "many-matches.md", "second-match.md"],
);
assert.equal(notes.readFile("checkpoint.md", 2, 2).content, "progress: smoke test");
assert.deepEqual(notes.searchContents("smoke").map((m) => m.path), ["checkpoint.md"]);
assert.deepEqual(notes.listFiles().map((f) => f.path), ["checkpoint.md"]);
assert.throws(() => notes.writeFile("../escape.txt", "nope"), /not allowed|escapes/);
assert.throws(() => notes.writeFile("a/./b.txt", "nope"), /not allowed/);
const capped = new NotesStore(dir, "notes-session-capped", 10);
capped.writeFile("small.txt", "0123456789");
capped.writeFile("b.txt", "0123456789"); // second file: largest-files hint only fires with ≥2 files
assert.throws(() => capped.appendToFile("small.txt", "x"), /must stay at or below/);
try {
	capped.appendToFile("small.txt", "overflow");
	assert.fail("expected append to throw");
} catch (err) {
	const msg = (err as Error).message;
	assert.ok(msg.includes("only 0 bytes left in this file"), msg);
	assert.ok(msg.includes("notes list"), msg);
	assert.ok(msg.includes("Largest note files"), msg);
}

// Same sessionDir, strict sessionId isolation, with no legacy-root fallback.
const notesB = new NotesStore(dir, "notes-session-b", 1_000_000);
notesB.writeFile("checkpoint.md", "goal: different session\nsecret-b\n");
assert.equal(notes.readFile("checkpoint.md").content, "goal: ship the plugin\nprogress: smoke test\n");
assert.equal(notesB.readFile("checkpoint.md").content, "goal: different session\nsecret-b\n");
assert.deepEqual(notes.searchContents("secret-b"), []);
assert.deepEqual(notesB.searchContents("smoke"), []);
assert.deepEqual(notes.listFiles().map((f) => f.path), ["checkpoint.md"]);
assert.deepEqual(notesB.listFiles().map((f) => f.path), ["checkpoint.md"]);
notesB.writeFile("checkpoint.md", "session-b replaced\n");
notesB.appendToFile("checkpoint.md", "session-b appended\n");
assert.equal(notes.readFile("checkpoint.md").content, "goal: ship the plugin\nprogress: smoke test\n");
assert.equal(notesB.readFile("checkpoint.md").content, "session-b replaced\nsession-b appended\n");
const legacyRoot = path.join(dir, "pi-token-budget", "notes");
fs.writeFileSync(path.join(legacyRoot, "legacy.md"), "legacy shared note", "utf8");
assert.deepEqual(notes.searchContents("legacy shared note"), []);
assert.deepEqual(notesB.listFiles().map((f) => f.path), ["checkpoint.md"]);

// --- notes char-level paging (single-line blind spot fix) ---------------------
const pager = new NotesStore(dir, "notes-session-paging", 1_000_000);
pager.writeFile("big-single-line.txt", "x".repeat(30_000));
const page1 = pager.readFile("big-single-line.txt", undefined, undefined, 0, 10_000);
assert.equal(page1.totalChars, 30_000);
assert.equal(page1.content.length, 10_000);
const page2 = pager.readFile("big-single-line.txt", undefined, undefined, 10_000, 10_000);
assert.equal(page2.content, "x".repeat(10_000));
const tail = pager.readFile("big-single-line.txt", undefined, undefined, 29_500);
assert.equal(tail.content, "x".repeat(500));
const pastEnd = pager.readFile("big-single-line.txt", undefined, undefined, 30_000, 10_000);
assert.equal(pastEnd.content, "");
// char window applies after line selection
pager.writeFile("checkpoint.md", "goal: ship the plugin\nprogress: smoke test\n");
const selected = pager.readFile("checkpoint.md", 2, 2, 2, 4);
assert.equal(selected.content, "ogre"); // "progress: smoke test" chars 2..6
assert.equal(selected.totalChars, "progress: smoke test".length);

// --- notes soft bloat warnings ----------------------------------------------
const warnStore = new NotesStore(dir, "notes-session-warn", 1_000_000);
warnStore.writeFile("tiny.md", "x");
assert.deepEqual(notesBloatWarnings(() => warnStore, DEFAULTS), []);
warnStore.writeFile("chonky.md", "y".repeat(70_000));
let warns = notesBloatWarnings(() => warnStore, DEFAULTS);
assert.equal(warns.length, 1);
assert.ok(warns[0].includes("chonky.md"), warns[0]);
assert.ok(warns[0].includes("62500"), warns[0]); // derived: notesMaxFileBytes/16
// thresholds derive from notesMaxFileBytes — a tiny cap means tiny thresholds
const tinyCfg = { ...DEFAULTS, notesMaxFileBytes: 160 }; // derived: file>10, total>40
const tinyStore = new NotesStore(dir, "notes-session-tiny", 160);
tinyStore.writeFile("a.md", "x".repeat(20)); // file warn fires, total (20≤40) does not
warns = notesBloatWarnings(() => tinyStore, tinyCfg);
assert.equal(warns.length, 1);
assert.ok(warns[0].includes("> 10)"), warns[0]);
const sprawl = new NotesStore(dir, "notes-session-sprawl", 1_000_000);
for (let i = 0; i < 6; i++) sprawl.writeFile(`part${i}.md`, "z".repeat(50_000)); // each under 64k, 300k total
warns = notesBloatWarnings(() => sprawl, DEFAULTS);
assert.equal(warns.length, 1);
assert.ok(warns[0].includes("total notes size") && warns[0].includes("300000"), warns[0]);

// Bloat statistics must inspect all files, not only the first 500 alphabetically.
const beyondListLimit = new NotesStore(dir, "notes-session-501", 1_000_000);
for (let i = 0; i < 500; i++) beyondListLimit.writeFile(`note-${i.toString().padStart(3, "0")}.md`, "x".repeat(500));
beyondListLimit.writeFile("z-oversized.md", "y".repeat(70_000));
warns = notesBloatWarnings(() => beyondListLimit, DEFAULTS);
assert.equal(warns.length, 2);
assert.ok(warns.some((warning) => warning.includes('"z-oversized.md"')), warns.join("\n"));
assert.ok(warns.some((warning) => warning.includes("501 files") && warning.includes("320000")), warns.join("\n"));

// Delete is explicit, path-safe, and only applies to regular note files.
const deletions = new NotesStore(dir, "notes-session-delete", 1_000_000);
deletions.writeFile("checkpoint.md", "checkpoint");
deletions.writeFile("nested/child.md", "child");
deletions.deleteFile("checkpoint.md");
assert.deepEqual(deletions.listFiles().map((file) => file.path), ["nested/child.md"]);
assert.throws(() => deletions.deleteFile("checkpoint.md"), /no note file/);
assert.throws(() => deletions.deleteFile("nested"), /no note file/);
assert.throws(() => deletions.deleteFile("../outside"), /unsupported path component/);
assert.deepEqual(
	notesBloatWarnings(() => {
		throw new Error("session not initialized yet");
	}, DEFAULTS),
	[],
);

// --- history -------------------------------------------------------------------
const branch = [
	{ id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "hello remote compact" }] } },
	{ id: "e2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } },
	{ id: "e3", type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } }] } },
	{ id: "e4", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "file.txt" }] } },
	{ id: "e5", type: "custom_message", content: "reminder injected" },
	{ id: "e6", type: "compaction", summary: bootstrapText({ firstWindowId: "w1", previousWindowId: "w1", currentWindowId: "w2", windowNumber: 2 }) },
	{ id: "e7", type: "message", message: { role: "assistant", content: [{ type: "text", text: "new window turn" }] } },
	{ id: "e8", type: "custom", data: {} }, // plugin state entry: excluded
];
const history = new HistoryStore(branch as never);
const windows = history.listWindows();
assert.equal(windows.length, 2);
assert.deepEqual(
	windows.map((w) => w.windowId),
	["w1", "w2"],
);
assert.ok(windows[1].openedByCompaction);
assert.deepEqual(
	windows.map((window) => [window.taskItems, window.allItems]),
	[[5, 5], [1, 2]],
	"window counts use the same task/all inclusion rules as retrieval",
);
const items = history.listItems({ scope: "all", kind: "all", recentFirst: false, previewChars: 50 });
assert.equal(items.length, 7); // e1..e5 in w1, then e6 (compaction bootstrap) + e7 in w2
assert.equal(items[0].itemId, "e1");
assert.equal(items[6].windowId, "w2");
const read = history.readItem("e1", 0, 5);
assert.equal(read.text, "hello");
assert.equal(read.totalChars, "hello remote compact".length);
const found = history.searchContents("remote", { excerptChars: 60 });
assert.deepEqual(
	found.map((f) => f.itemId),
	["e1"],
);
assert.ok(found[0].regions.some((region) => region.text.includes("remote")));
const w2Items = history.listItems({ windowId: "w2", scope: "all", kind: "all", recentFirst: false, previewChars: 50 });
assert.deepEqual(
	w2Items.map((i) => i.itemId),
	["e6", "e7"],
);
// tool call rendering is addressable too
const toolCall = history.readItem("e3", 0, 1000);
assert.ok(toolCall.text.includes("[tool_call bash]"));

// Compactions without our marker (foreign summarization) fall back to ordinal
// counting; marked rollovers always take the id embedded in their bootstrap.
const foreignBranch = [
	{ id: "f1", type: "message", message: { role: "user", content: [{ type: "text", text: "before foreign compact" }] } },
	{ id: "f2", type: "compaction", summary: "pi native summary, no marker" },
	{ id: "f3", type: "message", message: { role: "assistant", content: [{ type: "text", text: "after foreign compact" }] } },
];
const foreignHistory = new HistoryStore(foreignBranch as never);
assert.deepEqual(
	foreignHistory.listWindows().map((w) => w.windowId),
	["w1", "w2"],
);
assert.equal(foreignHistory.readItem("f3", 0, 100).windowId, "w2");

// Search coordinates address the same canonical UTF-16 text as readItem.
// Hidden blocks split searchable intervals, so a query cannot bridge them.
{
	const canonicalBranch = [
		{
			id: "c1",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "secret-before" },
					{ type: "text", text: "A😀needleZ" },
					{ type: "toolResult", content: "secret-nested" },
					{ type: "text", text: "tail needle" },
				],
			},
		},
		{ id: "c2", type: "message", message: { role: "user", content: `😀${"x".repeat(200)} hit xx hit xx hit xx hit` } },
		{ id: "c3", type: "message", message: { role: "toolResult", toolCallId: "future-call", content: [{ type: "thinking", thinking: "hidden-result-thought" }] } },
		{ id: "c4", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "future-call", name: "bash", arguments: { command: "echo later" } }] } },
		{ id: "c5", type: "message", message: { role: "toolResult", toolCallId: "future-call", content: "linked-after-call" } },
		{ id: "c6", type: "message", message: { role: "bashExecution", command: "pwd", output: "bash-output", exitCode: 0 } },
	];
	const canonical = new HistoryStore(canonicalBranch as never);
	const full = canonical.readItem("c1", 0, 1000);
	assert.equal(full.text, "A😀needleZ\ntail needle");
	assert.equal(full.totalChars, 22, "canonical offsets use JavaScript UTF-16 units");
	const hits = canonical.searchContents("needle", { recentFirst: false, excerptChars: 80 });
	assert.deepEqual(hits[0].regions.flatMap((region) => region.matches), [
		{ start: 3, end: 9 },
		{ start: 16, end: 22 },
	]);
	for (const region of hits[0].regions) {
		assert.equal(
			canonical.readItem("c1", region.readOffset, region.readLimit).text,
			region.text,
			"search read coordinates reproduce the exact excerpt",
		);
	}
	assert.deepEqual(canonical.searchContents("secret", { scope: "all", excerptChars: 80 }), []);
	assert.deepEqual(canonical.searchContents("Z\ntail", { excerptChars: 80 }), [], "hidden source blocks prevent cross-gap matches");

	const many = canonical.searchContents("hit", { recentFirst: false, excerptChars: 45 }).find((item) => item.itemId === "c2");
	assert.ok(many);
	assert.equal(many.regions.flatMap((region) => region.matches).length, 3);
	assert.equal(many.moreMatchesInItem, true);
	assert.equal(many.regions[0].matches[0].start, 203, "emoji contributes two UTF-16 code units");

	assert.equal(canonical.readItem("c3", 0, 100).text, "[empty tool result]");
	assert.equal(canonical.readItem("c3", 0, 100).source?.toolName, undefined, "future calls never back-fill a result source");
	assert.equal(canonical.readItem("c5", 0, 100).source?.toolName, "bash", "prior calls associate missing toolName");
	assert.equal(canonical.readItem("c6", 0, 100).text, "bash-output");
	assert.equal(canonical.readItem("c6", 0, 100).source?.toolName, "bash");
}

// --- history lazy rendering ----------------------------------------------
// The constructor is a metadata-only pass; text is built per touched entry.
{
	const lazy = new HistoryStore(branch as never);
	assert.equal(lazy.renderedTextCount(), 0, "constructor must not render any entry text");
	assert.equal(lazy.readItem("e1", 0, 5).text, "hello");
	assert.equal(lazy.renderedTextCount(), 1, "readItem renders exactly one entry");

	const lazyAll = new HistoryStore(branch as never);
	const lazyItems = lazyAll.listItems({ scope: "all", kind: "all", recentFirst: false, previewChars: 50 });
	assert.equal(lazyItems.length, 7);
	assert.equal(lazyAll.renderedTextCount(), 7, "full listItems renders its complete page");
	assert.equal(lazyItems[0].totalChars, "hello remote compact".length, "totalChars stays exact under lazy rendering");

	// Repeated paginated reads of one item render independently and correctly.
	const paged = new HistoryStore(branch as never);
	const p1 = paged.readItem("e1", 0, 5);
	const p2 = paged.readItem("e1", 5, 100);
	assert.equal(p1.text, "hello");
	assert.equal(p2.text, " remote compact");
	assert.equal(p1.totalChars, p2.totalChars);
	assert.equal(paged.renderedTextCount(), 1, "repeated pages reuse the canonical render");
}

// Inclusion/exclusion equivalence: the cheap metadata pass must exactly
// mirror the rendered-text emptiness rules, including block contributions.
{
	const edgeBranch = [
		// thinking-only assistant → renders empty → excluded, never counted
		{ id: "x1", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] } },
		// whitespace-only user text → excluded
		{ id: "x2", type: "message", message: { role: "user", content: [{ type: "text", text: "   \n\t " }] } },
		// empty toolResult → included with placeholder
		{ id: "x3", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "" }] } },
		// content neither string nor array → excluded
		{ id: "x4", type: "message", message: { role: "assistant", content: 42 } },
		// unknown block type → included, renders "[foo block omitted]"
		{ id: "x5", type: "message", message: { role: "assistant", content: [{ type: "foo", data: 1 }] } },
		// toolResult blocks inside assistant content contribute nothing
		{ id: "x6", type: "message", message: { role: "assistant", content: [{ type: "toolResult", content: "ignored" }, { type: "thinking" }] } },
		// plain string content → included
		{ id: "x7", type: "message", message: { role: "user", content: "plain string request" } },
		// compaction with empty summary opens a window but has no readable body
		{ id: "x8", type: "compaction", summary: "" },
	];
	const edgeStore = new HistoryStore(edgeBranch as never);
	assert.deepEqual(
		edgeStore.listItems({ scope: "all", kind: "all", recentFirst: false, previewChars: 200 }).map((i) => i.itemId),
		["x3", "x5", "x7"],
	);
	assert.equal(edgeStore.readItem("x3", 0, 100).text, "[empty tool result]");
	assert.ok(edgeStore.readItem("x5", 0, 100).text.includes("[foo block omitted]"));
	const w1 = edgeStore.listWindows().find((w) => w.windowId === "w1");
	assert.ok(w1);
	assert.equal(w1.allItems, 3, "empty-render entries never enter window counts");
	assert.equal(w1.taskItems, 3, "non-bookkeeping edge entries remain in task scope");
	assert.equal(edgeStore.listWindows().at(-1)?.windowId, "w2", "empty compaction still opens a window");
}

// Extension bookkeeping messages must not consume slots from a bounded
// recent-item index: their previews are self-referential noise ("save your
// notes"), never task conversation. Entry e5 above has no customType and is
// therefore a foreign custom message that stays.
{
	const noisyBranch = [
		{ id: "n1", type: "message", message: { role: "user", content: [{ type: "text", text: "real request" }] } },
		{ id: "n2", type: "custom_message", customType: "pi-token-budget:reminder", content: "budget nudge" },
		{ id: "n3", type: "custom_message", customType: "pi-token-budget:fallback", content: "checkpoint now" },
		{ id: "n4", type: "custom_message", customType: "pi-token-budget:continue", content: "keep going" },
		{ id: "n5", type: "custom_message", customType: "reframe:audit", content: "another extension's message" },
		{ id: "n6", type: "message", message: { role: "assistant", content: [{ type: "text", text: "real answer" }] } },
		{ id: "n7", type: "custom_message", customType: "pi-token-budget:manual-checkpoint", content: "manual checkpoint request" },
	];
	const noisy = new HistoryStore(noisyBranch as never);
	assert.deepEqual(
		noisy.listItems({ scope: "task", kind: "all", recentFirst: false, previewChars: 40 }).map((i) => i.itemId),
		["n1", "n5", "n6"],
	);
	// The filter runs before the limit: excluded entries must not displace kept ones.
	assert.deepEqual(
		noisy
			.listItems({ scope: "task", kind: "all", previewChars: 40, recentFirst: true, limit: 2 })
			.map((i) => i.itemId),
		["n6", "n5"],
	);
	assert.equal(noisy.listItems({ scope: "all", kind: "all", recentFirst: false, previewChars: 40 }).length, 7, "all scope retains diagnostics");
	assert.deepEqual(noisy.searchContents("checkpoint", { scope: "task", excerptChars: 40 }), []);
	assert.deepEqual(noisy.searchContents("checkpoint", { scope: "all", excerptChars: 40 }).map((i) => i.itemId), ["n7", "n3"]);
}

// Task projection blocks recursive recovery noise without losing ordinary
// evidence or useful blocks that share an assistant message with history.
{
	const projectedBranch = [
		{ id: "p1", type: "message", message: { role: "user", content: [{ type: "text", text: "original alpha request" }] } },
		{
			id: "p2",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "SECRET structured thought alpha" },
					{ type: "text", text: "visible assistant explanation" },
					{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "printf alpha-evidence" } },
					{ type: "toolCall", id: "history-old", name: "history", arguments: { operation: "search_contents", query: "alpha" } },
					{ type: "toolCall", id: "history-current", name: "history_search", arguments: { query: "self-only-token" } },
				],
			},
		},
		{
			id: "p3",
			type: "message",
			message: { role: "toolResult", toolCallId: "history-old", toolName: "history", content: [{ type: "text", text: "old recursive alpha result" }] },
		},
		{
			id: "p4",
			type: "message",
			message: { role: "toolResult", toolCallId: "bash-1", content: [{ type: "text", text: "alpha-evidence" }] },
		},
		{
			id: "p5",
			type: "message",
			message: { role: "toolResult", toolCallId: "unknown-call", content: [{ type: "text", text: "unknown-source-kept" }] },
		},
		{ id: "p6", type: "custom_message", customType: "pi-token-budget:reminder", content: "internal budget reminder" },
		{ id: "p7", type: "custom_message", customType: "foreign:audit", content: "external extension record" },
		{
			id: "p8",
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", id: "history-repeat", name: "history_search", arguments: { query: "alpha" } }] },
		},
		{
			id: "p9",
			type: "message",
			message: { role: "toolResult", toolCallId: "history-repeat", toolName: "history_search", content: [{ type: "text", text: "wrapped alpha results" }] },
		},
	];
	const beforeRepeat = new HistoryStore(projectedBranch.slice(0, 7) as never).searchContents("alpha", {
		scope: "task",
		excerptChars: 200,
	});
	const projected = new HistoryStore(projectedBranch as never);
	assert.deepEqual(
		projected.searchContents("alpha", { scope: "task", excerptChars: 200 }).map((item) => item.itemId),
		beforeRepeat.map((item) => item.itemId),
		"adding another history call/result does not change task matches",
	);
	assert.deepEqual(
		projected.searchContents("self-only-token", {
			scope: "all",
			kind: "all",
			excludedToolCallId: "history-current",
			excerptChars: 200,
		}),
		[],
		"the executing history block is excluded even from all scope",
	);
	assert.deepEqual(
		projected.searchContents("old recursive", { scope: "task", excerptChars: 200 }),
		[],
		"prior history results do not flow back into task search",
	);
	assert.deepEqual(
		projected.searchContents("old recursive", { scope: "all", excerptChars: 200 }).map((item) => item.itemId),
		["p3"],
		"all scope keeps prior internal records for diagnostics",
	);
	const internalCall = projected.searchContents("search_contents", { scope: "all", kind: "tool_call", excerptChars: 200 });
	assert.deepEqual(internalCall.map((item) => item.itemId), ["p2"]);
	assert.equal(internalCall[0].internal, true, "mixed messages mark projected internal blocks in all scope");
	assert.deepEqual(
		projected.searchContents("alpha-evidence", { scope: "task", kind: "message", excerptChars: 200 }).map((item) => item.itemId),
		[],
		"message projection never matches tool arguments or results",
	);
	assert.deepEqual(
		projected.searchContents("alpha-evidence", { scope: "task", kind: "tool_call", excerptChars: 200 }).map((item) => item.itemId),
		["p2"],
	);
	const evidence = projected.searchContents("alpha-evidence", { scope: "task", kind: "tool_result", excerptChars: 200 });
	assert.deepEqual(evidence.map((item) => item.itemId), ["p4"]);
	assert.equal(evidence[0].source?.toolName, "bash", "missing toolName is recovered through toolCallId");
	assert.equal(evidence[0].source?.assistantItemId, "p2");
	assert.deepEqual(
		projected.searchContents("unknown-source-kept", { scope: "task", kind: "tool_result", excerptChars: 200 }).map((item) => item.itemId),
		["p5"],
		"unknown tool-result sources are retained rather than guessed away",
	);
	const messageOnly = projected.listItems({ scope: "task", kind: "message", recentFirst: false, previewChars: 500 });
	assert.deepEqual(messageOnly.map((item) => item.itemId), ["p1", "p2"]);
	assert.ok(messageOnly[1].preview.includes("visible assistant explanation"));
	assert.ok(!messageOnly[1].preview.includes("SECRET") && !messageOnly[1].preview.includes("tool_call"));
	assert.ok(projected.readItem("p3", 0, 500).text.includes("old recursive"), "hidden task records stay readable by stable id");
	assert.equal(projected.readItem("p4", 0, 500).source?.toolName, "bash");
	assert.deepEqual(
		projected.listItems({ scope: "task", kind: "all", recentFirst: false, previewChars: 100 }).map((item) => item.itemId),
		["p1", "p2", "p4", "p5", "p7"],
		"task scope filters internal calls/results and plugin custom messages before limiting",
	);
}

// Laziness holds at scale: a single read_item renders exactly one entry
// regardless of branch size (no timing assertions, no flake).
{
	const bigBranch: unknown[] = [];
	for (let i = 0; i < 5000; i++) {
		bigBranch.push({
			id: `big-${i}`,
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: `turn ${i} payload` }] },
		});
	}
	const bigStore = new HistoryStore(bigBranch as never);
	const bigRead = bigStore.readItem("big-4999", 0, 9);
	assert.equal(bigRead.text, "turn 4999");
	assert.equal(bigStore.renderedTextCount(), 1, "single read_item renders exactly one entry");

	// search short-circuits in scan order: identical result set to
	// filter-all-then-slice, without rendering past the limit-th match.
	const recentStore = new HistoryStore(bigBranch as never);
	assert.deepEqual(
		recentStore.searchContents("turn", { limit: 3, recentFirst: true, excerptChars: 50 }).map((m) => m.itemId),
		["big-4999", "big-4998", "big-4997"],
	);
	assert.equal(recentStore.renderedTextCount(), 3, "recent-first search stops after limit matches");
	const forwardStore = new HistoryStore(bigBranch as never);
	assert.deepEqual(
		forwardStore.searchContents("turn", { limit: 2, recentFirst: false, excerptChars: 50 }).map((m) => m.itemId),
		["big-0", "big-1"],
	);
	assert.equal(forwardStore.renderedTextCount(), 2, "forward search stops after limit matches");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("smoke: all assertions passed");
