/** Read-only remote recovery never opens another Pi session manager.
 * Immutable entry records retain images; an atomic manifest selects the branch.
 * This also persists SDK in-memory sessions after their process exits. */
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWrite, readJson, withFileLock } from "../storage.ts";
import { identityHash, type AgentRegistration } from "../task-registry.ts";

export interface JournalEntry { id: string; type: string; [key: string]: unknown }
interface Manifest { version: 1; ids: string[] }

export class HistoryJournal {
	private lastBranch = "";
	private readonly known = new Set<string>();
	private readonly agent: AgentRegistration;
	constructor(agent: AgentRegistration) { this.agent = agent; }

	sync(branch: JournalEntry[]): void {
		const manifest = path.join(this.agent.historyDir, "branch.json");
		const ids = branch.map(e => e.id);
		const signature = JSON.stringify(ids);
		if (signature === this.lastBranch) return;
		withFileLock(manifest, () => {
			for (const entry of branch) {
				if (this.known.has(entry.id)) continue;
				const file = this.entryFile(entry.id);
				if (!fs.existsSync(file)) atomicWrite(file, JSON.stringify(entry));
				this.known.add(entry.id);
			}
			atomicWrite(manifest, JSON.stringify({ version: 1, ids } satisfies Manifest));
		});
		this.lastBranch = signature;
	}

	readBranch(): JournalEntry[] {
		const manifest = readJson<Manifest>(path.join(this.agent.historyDir, "branch.json"));
		if (!manifest) return [];
		if (manifest.version !== 1) throw new Error("Unsupported history journal version");
		return manifest.ids.map(id => {
			const entry = readJson<JournalEntry>(this.entryFile(id));
			if (!entry || entry.id !== id) throw new Error(`History journal entry unavailable: ${id}`);
			return entry;
		});
	}

	private entryFile(id: string): string { return path.join(this.agent.historyDir, "entries", `${identityHash(id)}.json`); }
}
