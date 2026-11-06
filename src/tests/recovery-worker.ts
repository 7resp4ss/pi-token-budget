/** Child-process fixture: no model or network access. */
import * as fs from "node:fs";
import { NotesStore } from "../stores/notes-store.ts";
import { TaskRegistry } from "../task-registry.ts";
import { HistoryJournal } from "../stores/history-journal.ts";
const [mode, directory, payload] = process.argv.slice(2);
if (mode === "append") {
	const { worker, count, cap = 1_000_000 } = JSON.parse(payload);
	const notes = new NotesStore(directory, "concurrent", cap);
	let written = 0;
	for (let i = 0; i < count; i++) {
		try { notes.appendToFile("log", `${worker}:${i}\n`); written++; }
		catch (error) { if (!(error as Error).message.includes("must stay at or below")) throw error; }
	}
	console.log(written);
} else if (mode === "history") {
	const { task, branch } = JSON.parse(fs.readFileSync(payload, "utf8"));
	const registered = new TaskRegistry({ sessionDir: directory, sessionId: "exited-child", task });
	new HistoryJournal(registered.agent).sync(branch);
	console.log(registered.agent.agentName);
} else throw new Error(`Unknown fixture mode ${mode}`);
