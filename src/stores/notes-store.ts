/**
 * Notes store: the model's persistent, window-surviving checkpoint space.
 *
 * A tiny virtual filesystem rooted at
 * <sessionDir>/pi-token-budget/notes/<sessionId>/.
 * Paths are virtual (never escape the session root), files are capped at
 * notesMaxFileBytes, and all operations are synchronous against local disk
 * so writes are immediately visible to reads.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export class NotesError extends Error {}

export interface NoteReadResult {
	/** Windowed content: line-selected first, then char-windowed. */
	content: string;
	/** Char length of the line-selected content — the pagination base. */
	totalChars: number;
}

export class NotesStore {
	private readonly root: string;
	private readonly maxFileBytes: number;

	constructor(sessionDir: string, sessionId: string, maxFileBytes: number) {
		this.root = path.join(sessionDir, "pi-token-budget", "notes", sessionId);
		this.maxFileBytes = maxFileBytes;
		try {
			fs.mkdirSync(this.root, { recursive: true });
		} catch {
			// best effort; operations below will surface errors
		}
	}

	/** Validate and resolve a virtual path inside the notes root. */
	private resolve(notePath: string): string {
		if (typeof notePath !== "string" || notePath.length === 0) {
			throw new NotesError("path is required");
		}
		if (notePath.includes("\0")) throw new NotesError("path contains NUL");
		const segments = notePath.split("/");
		for (const seg of segments) {
			if (seg === "" || seg === "." || seg === "..") {
				throw new NotesError(`unsupported path component in "${notePath}" (empty, '.', and '..' are not allowed)`);
			}
		}
		if (notePath.length > 512) throw new NotesError("path too long (max 512 chars)");
		const resolved = path.resolve(this.root, notePath);
		if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
			throw new NotesError("path escapes the notes directory");
		}
		return resolved;
	}

	/** Top-N largest note files, for at-capacity error guidance. Only meaningful
	 * when more than one file exists — otherwise the hint would just echo the
	 * file being appended. */
	private largestFilesHint(top = 3): string {
		const files = this.listFiles()
			.sort((a, b) => b.bytes - a.bytes)
			.slice(0, top);
		if (files.length < 2) return "";
		return ` Largest note files: ${files.map((f) => `${f.path} (${f.bytes} bytes)`).join(", ")}.`;
	}

	writeFile(notePath: string, text: string): void {
		const file = this.resolve(notePath);
		const size = Buffer.byteLength(text, "utf8");
		if (size > this.maxFileBytes) {
			throw new NotesError(
				`content is ${size} bytes; note files must stay at or below ${this.maxFileBytes} bytes. Write a smaller file, split across several files, or prune obsolete notes first (notes list).${this.largestFilesHint()}`,
			);
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text, "utf8");
	}

	appendToFile(notePath: string, text: string): void {
		const file = this.resolve(notePath);
		const existing = fs.existsSync(file) ? fs.statSync(file).size : 0;
		const addition = Buffer.byteLength(text, "utf8");
		if (existing + addition > this.maxFileBytes) {
			const remaining = Math.max(0, this.maxFileBytes - existing);
			throw new NotesError(
				`append would grow "${notePath}" to ${existing + addition} bytes; note files must stay at or below ${this.maxFileBytes} bytes (only ${remaining} bytes left in this file). Split the append into a smaller piece or create another file. Run notes list to review which files can be pruned — the budget reminder also suggests cleaning obsolete notes.${this.largestFilesHint()}`,
			);
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, text, "utf8");
	}

	readFile(notePath: string, startLine?: number, stopLine?: number, offsetChars?: number, limitChars?: number): NoteReadResult {
		const file = this.resolve(notePath);
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
			throw new NotesError(`no note file at "${notePath}"`);
		}
		const text = fs.readFileSync(file, "utf8");
		let selected = text;
		if (startLine !== undefined || stopLine !== undefined) {
			const lines = text.split("\n");
			let start = startLine ?? 1;
			let stop = stopLine ?? lines.length;
			if (start < 0) start = lines.length + 1 + start;
			if (stop < 0) stop = lines.length + 1 + stop;
			start = Math.max(1, start);
			stop = Math.min(lines.length, stop);
			if (start > stop) throw new NotesError(`line range ${startLine}..${stopLine} is empty for "${notePath}"`);
			selected = lines.slice(start - 1, stop).join("\n");
		}
		const totalChars = selected.length;
		const offset = Math.min(Math.max(0, offsetChars ?? 0), totalChars);
		const end = limitChars === undefined ? totalChars : Math.min(totalChars, offset + Math.max(0, limitChars));
		return { content: selected.slice(offset, end), totalChars };
	}

	listFiles(prefix?: string, maxResults?: number): Array<{ path: string; bytes: number; updatedAt: string }> {
		const base = prefix ? this.resolve(prefix) : this.root;
		if (!fs.existsSync(base)) return [];
		const out: Array<{ path: string; bytes: number; updatedAt: string }> = [];
		const walk = (dir: string): void => {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const ent of entries) {
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) walk(full);
				else if (ent.isFile()) {
					const stat = fs.statSync(full);
					out.push({
						path: path.relative(this.root, full).split(path.sep).join("/"),
						bytes: stat.size,
						updatedAt: new Date(stat.mtimeMs).toISOString(),
					});
				}
			}
		};
		if (fs.statSync(base).isFile()) {
			const stat = fs.statSync(base);
			return [
				{
					path: path.relative(this.root, base).split(path.sep).join("/"),
					bytes: stat.size,
					updatedAt: new Date(stat.mtimeMs).toISOString(),
				},
			];
		}
		walk(base);
		out.sort((a, b) => a.path.localeCompare(b.path));
		return maxResults ? out.slice(0, Math.max(1, maxResults)) : out;
	}

	searchContents(query: string, prefix?: string, maxFiles?: number, maxMatchesPerFile?: number): Array<{ path: string; line: number; text: string }> {
		const results: Array<{ path: string; line: number; text: string }> = [];
		const files = this.listFiles(prefix).filter((f) => f.bytes <= this.maxFileBytes);
		for (const f of files) {
			if (maxFiles && results.length >= maxFiles) break;
			let perFile = 0;
			const text = fs.readFileSync(path.join(this.root, f.path), "utf8");
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (maxMatchesPerFile && perFile >= maxMatchesPerFile) break;
				if (lines[i].includes(query)) {
					results.push({ path: f.path, line: i + 1, text: lines[i] });
					perFile++;
				}
			}
		}
		return results;
	}
}
