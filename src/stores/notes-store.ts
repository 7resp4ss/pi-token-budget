/**
 * Notes store: the model's persistent, window-surviving checkpoint space.
 *
 * A tiny virtual filesystem rooted at
 * <sessionDir>/pi-token-budget/notes/<sessionId>/ or a task-registry root.
 * Paths are virtual (never escape the session root), files are capped at
 * notesMaxFileBytes, and all operations are synchronous against local disk
 * so writes are immediately visible to reads.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite, charLength, charSlice, readJson, withFileLock } from "../storage.ts";

export class NotesError extends Error {}

export interface NoteReadResult {
	/** Windowed content: line-selected first, then char-windowed. */
	content: string;
	/** Char length of the line-selected content — the pagination base. */
	totalChars: number;
}

export interface NoteFileInfo {
	path: string;
	bytes: number;
	updatedAt: string;
	createdAt: string;
}

export interface NotesStats {
	totalFiles: number;
	totalBytes: number;
	largestFiles: Array<Pick<NoteFileInfo, "path" | "bytes">>;
}

export class NotesStore {
	private readonly root: string;
	private readonly maxFileBytes: number;
	private readonly metadataRoot: string;

	constructor(sessionDir: string, sessionId: string, maxFileBytes: number, root?: string) {
		this.root = root ?? path.join(sessionDir, "pi-token-budget", "notes", sessionId);
		this.metadataRoot = `${this.root}.metadata`;
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
		if (notePath.includes("\\")) throw new NotesError("backslashes are unsupported in virtual paths");
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
		let component = this.root;
		for (const seg of segments) {
			component = path.join(component, seg);
			if (fs.existsSync(component) && fs.lstatSync(component).isSymbolicLink()) throw new NotesError("symlinks are unsupported in note paths");
		}
		return resolved;
	}

	/** Top-N largest note files, for at-capacity error guidance. Only meaningful
	 * when more than one file exists — otherwise the hint would just echo the
	 * file being appended. */
	private largestFilesHint(top = 3): string {
		const stats = this.measureStats(top);
		if (stats.totalFiles < 2) return "";
		return ` Largest note files: ${stats.largestFiles.map((f) => `${f.path} (${f.bytes} bytes)`).join(", ")}.`;
	}

	private metadataFile(notePath: string): string {
		return path.join(this.metadataRoot, `${createHash("sha256").update(notePath).digest("hex")}.json`);
	}

	private mutate(notePath: string, text: string, append: boolean): void {
		const file = this.resolve(notePath);
		const metadata = this.metadataFile(notePath);
		withFileLock(metadata, () => {
			const exists = fs.existsSync(file);
			const stat = exists ? fs.statSync(file) : undefined;
			const content = append && exists ? fs.readFileSync(file, "utf8") + text : text;
			const size = Buffer.byteLength(content, "utf8");
			if (size > this.maxFileBytes) throw new NotesError(
				`content would be ${size} bytes; note files must stay at or below ${this.maxFileBytes} bytes (only ${Math.max(0, this.maxFileBytes - (stat?.size ?? 0))} bytes left in this file). Use notes_list_files_by_prefix to review files, prune with notes_write_file, or split across files.${this.largestFilesHint()}`,
			);
			const previous = readJson<{ createdAt: string }>(metadata);
			const now = new Date().toISOString();
			// Store creation identity before replacing the inode; overwrites keep it.
			atomicWrite(metadata, JSON.stringify({ createdAt: previous?.createdAt ?? (stat ? new Date(stat.birthtimeMs || stat.mtimeMs).toISOString() : now), updatedAt: now }));
			// Stage outside the model-visible notes tree so concurrent listings
			// cannot surface a writer's temporary or partially written file.
			atomicWrite(file, content, this.metadataRoot);
		});
	}

	writeFile(notePath: string, text: string): void { this.mutate(notePath, text, false); }
	appendToFile(notePath: string, text: string): void { this.mutate(notePath, text, true); }

	/** Internal maintenance API; deliberately absent from the model tool surface. */
	deleteFile(notePath: string): void {
		const file = this.resolve(notePath);
		withFileLock(this.metadataFile(notePath), () => {
			if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new NotesError(`no note file at "${notePath}"`);
			fs.unlinkSync(file);
			fs.rmSync(this.metadataFile(notePath), { force: true });
		});
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
		const totalChars = charLength(selected);
		const offset = Math.min(Math.max(0, offsetChars ?? 0), totalChars);
		const end = limitChars === undefined ? totalChars : Math.min(totalChars, offset + Math.max(0, limitChars));
		return { content: charSlice(selected, offset, end), totalChars };
	}

	listFiles(prefix?: string, maxResults?: number, orderBy: "name" | "created_at" | "updated_at" = "name", order: "ascending" | "descending" = "ascending"): NoteFileInfo[] {
		// A prefix is a string prefix, not an existing directory requirement.
		if (prefix) this.resolve(prefix);
		const out: NoteFileInfo[] = [];
		const walk = (dir: string): void => {
			for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) walk(full);
				else if (ent.isFile()) {
					const notePath = path.relative(this.root, full).split(path.sep).join("/");
					if (prefix && !notePath.startsWith(prefix)) continue;
					const stat = fs.statSync(full);
					const meta = readJson<{ createdAt: string; updatedAt: string }>(this.metadataFile(notePath));
					out.push({ path: notePath, bytes: stat.size, createdAt: meta?.createdAt ?? new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(), updatedAt: new Date(stat.mtimeMs).toISOString() });
				}
			}
		};
		if (fs.existsSync(this.root)) walk(this.root);
		const field = orderBy === "created_at" ? "createdAt" : orderBy === "updated_at" ? "updatedAt" : "path";
		const sign = order === "descending" ? -1 : 1;
		out.sort((a, b) => sign * (a[field].localeCompare(b[field]) || a.path.localeCompare(b.path)));
		return maxResults ? out.slice(0, maxResults) : out;
	}

	/** Return complete size/count totals and only the largest file entries. */
	measureStats(top = 5): NotesStats {
		const limit = Math.max(0, Math.floor(top));
		let totalFiles = 0;
		let totalBytes = 0;
		const largestFiles: Array<Pick<NoteFileInfo, "path" | "bytes">> = [];

		const consider = (file: Pick<NoteFileInfo, "path" | "bytes">): void => {
			totalFiles++;
			totalBytes += file.bytes;
			if (limit === 0) return;
			largestFiles.push(file);
			largestFiles.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
			if (largestFiles.length > limit) largestFiles.pop();
		};

		const walk = (dir: string): void => {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const ent of entries) {
				const full = path.join(dir, ent.name);
				if (ent.isDirectory()) walk(full);
				else if (ent.isFile()) {
					consider({
						path: path.relative(this.root, full).split(path.sep).join("/"),
						bytes: fs.statSync(full).size,
					});
				}
			}
		};

		if (fs.existsSync(this.root)) walk(this.root);
		return { totalFiles, totalBytes, largestFiles };
	}

	searchContents(query: string, prefix?: string, maxFiles?: number, maxMatchesPerFile?: number, recentFileFirst = false): Array<{ path: string; line: number; text: string }> {
		const results: Array<{ path: string; line: number; text: string }> = [];
		const files = this.listFiles(prefix, undefined, recentFileFirst ? "created_at" : "name", recentFileFirst ? "descending" : "ascending").filter((f) => f.bytes <= this.maxFileBytes);
		let matchedFileCount = 0;
		for (const f of files) {
			if (maxFiles && matchedFileCount >= maxFiles) break;
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
			if (perFile > 0) matchedFileCount++;
		}
		return results;
	}
}
