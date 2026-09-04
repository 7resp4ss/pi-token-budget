/**
 * Smoke test for the pure modules (no pi runtime needed).
 * Run: npm run smoke  (compiles to .smoke/ and executes with node)
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULTS, reminderThreshold, resolveForModel, type ConfigBundle } from "../config.ts";
import { HistoryStore } from "../stores/history-store.ts";
import { NotesStore } from "../stores/notes-store.ts";
import { BOOTSTRAP_MARKER, bootstrapText, guidanceMessage, reminderMessage } from "../prompts.ts";
import { notesBloatWarnings } from "../tools/deps.ts";
import { commitRollover, freshState, inferFromBranch, loadState, saveState } from "../state.ts";

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
		"*": { maxToolOutputChars: 8000 },
	},
};
assert.equal(resolveForModel(bundle, "openai", "gpt-5.6-codex").hardRolloverUsedTokens, 256_000); // exact wins
assert.equal(resolveForModel(bundle, "anthropic", "claude-opus-4").hardRolloverUsedTokens, 160_000); // provider/* beats bare provider
assert.equal(resolveForModel(bundle, "anthropic", "claude-opus-4").reminderRemainingPercent, 0.3);
assert.equal(resolveForModel(bundle, "google", "gemini-2.5-pro").maxToolOutputChars, 8000); // * fallback
assert.equal(resolveForModel(bundle, "google", "gemini-2.5-pro").hardRolloverUsedTokens, 0); // untouched keys inherit defaults
assert.deepEqual(resolveForModel(bundle, undefined, undefined), bundle.defaults); // no model: defaults

// --- state machine --------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-token-budget-smoke-"));
let st = freshState("s1");
assert.equal(st.windowNumber, 1);
assert.equal(st.previousWindowId, null);
assert.equal(st.currentWindowId, "w1", "window id is the ordinal");
st = { ...st, pendingNewContext: true, reminderDelivered: true, fallbackDelivered: true, fallbackActive: true };
st = commitRollover(st, { id: "w-next01", number: 2 });
assert.equal(st.windowNumber, 2);
assert.equal(st.currentWindowId, "w-next01");
assert.equal(st.reminderDelivered, false, "one-shot flags reset per window");
assert.equal(st.pendingNewContext, false);
assert.equal(st.fallbackActive, false);
saveState(dir, st);
assert.deepEqual(loadState(dir, "s1").currentWindowId, "w-next01");

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
	["src/auth.ts (last edit: e17)", "(2 other file(s) also edited — recover those edits with history search_contents \"[tool_call\", or list_items role \"assistant\")"],
);
assert.ok(bootWithFiles.includes("Files edited in this session"));
assert.ok(bootWithFiles.includes("src/auth.ts (last edit: e17)"));
assert.ok(bootWithFiles.includes("2 other file(s) also edited"));
assert.ok(guidanceMessage({ firstWindowId: "w-a", previousWindowId: null, currentWindowId: "w-c", windowNumber: 1 }).includes("verbatim"), "guidance requires verbatim quotes");
assert.ok(reminderMessage("w-c", 1234).includes("verbatim"), "reminder requires verbatim quotes");
assert.ok(reminderMessage("w-c", 1234).includes("only 1234 tokens remain"));
assert.ok(reminderMessage("w-c", 1234).includes('source_context_window_id="w-c"'));
assert.ok(reminderMessage("w-c", 1234).includes("clean up old notes"), "generic cleanup advice when no bloat");
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
const items = history.listItems({ previewChars: 50 });
assert.equal(items.length, 7); // e1..e5 in w1, then e6 (compaction bootstrap) + e7 in w2
assert.equal(items[0].itemId, "e1");
assert.equal(items[6].windowId, "w2");
const read = history.readItem("e1", 0, 5);
assert.equal(read.text, "hello");
assert.equal(read.totalChars, "hello remote compact".length);
const found = history.searchContents("remote", { previewChars: 60 });
assert.deepEqual(
	found.map((f) => f.itemId),
	["e1"],
);
assert.ok(found[0].preview.includes("remote"));
const w2Items = history.listItems({ windowId: "w2", previewChars: 50 });
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

fs.rmSync(dir, { recursive: true, force: true });
console.log("smoke: all assertions passed");
