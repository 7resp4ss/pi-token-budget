/**
 * Tool: notes
 * ============
 * The model's persistent checkpoint space — a multi-operation tool over the
 * NotesStore virtual filesystem (src/stores/notes-store.ts). Notes survive
 * window rollovers and session restarts (stored under
 * <sessionDir>/pi-token-budget/notes/<sessionId>/), making them the primary
 * information-continuity channel of the whole mechanism.
 *
 * Operations:
 *   write   — create or replace a note file
 *   append  — add to the end of a note file (checkpoint accumulation)
 *   read    — full file, 1-based line range (negative = from the end),
 *             and/or a char window (offset_chars/limit_chars) so content
 *             beyond a very long single line stays reachable
 *   search  — literal substring across files (bounded matches)
 *   list    — files under an optional path prefix (+ soft bloat warnings)
 *
 * Constraints enforced by the store: virtual paths only (no traversal),
 * 1MB per file, reads reflect writes immediately.
 */

import { Type } from "typebox";
import { TOOL_PRIVATE_USAGE_HINT } from "../prompts.ts";
import { truncate } from "../stores/history-store.ts";
import { clampInt, notesBloatWarnings, optionalInt, optionalString, requiredString, textResult, type ToolDeps, type ToolRegistrar } from "./deps.ts";

const NOTES_PARAMS = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("read"),
			Type.Literal("write"),
			Type.Literal("append"),
			Type.Literal("search"),
			Type.Literal("list"),
		],
		{ description: "Which notes operation to run." },
	),
	path: Type.Optional(Type.String({ description: "Virtual note path, e.g. \"checkpoint.md\". Required for read/write/append." })),
	text: Type.Optional(Type.String({ description: "Content for write/append. 'write' replaces the whole file; 'append' adds to the end." })),
	query: Type.Optional(Type.String({ description: "Literal substring for search." })),
	prefix: Type.Optional(Type.String({ description: "Path prefix for list/search." })),
	start_line: Type.Optional(Type.Integer({ description: "First line to read (1-based; negative counts from the end).", minimum: -1_000_000 })),
	stop_line: Type.Optional(Type.Integer({ description: "Last line to read (1-based, inclusive; negative counts from the end).", minimum: -1_000_000 })),
	offset_chars: Type.Optional(
		Type.Integer({
			description: "Zero-based char offset into the selected content (applied after any line range). Use to page past very long lines.",
			minimum: 0,
		}),
	),
	limit_chars: Type.Optional(
		Type.Integer({
			description: "Max chars to return from the selected content. Clamped to the tool output cap, so the returned range is always shown in full.",
			minimum: 1,
			maximum: 100_000,
		}),
	),
	max_results: Type.Optional(Type.Integer({ description: "Max files for list.", minimum: 1, maximum: 500 })),
	max_files: Type.Optional(Type.Integer({ description: "Max matching files for search.", minimum: 1, maximum: 500 })),
	max_matches_per_file: Type.Optional(Type.Integer({ description: "Max matching lines per file for search.", minimum: 1, maximum: 100 })),
});

export function registerNotesTool(pi: ToolRegistrar, deps: ToolDeps): void {
	const config = deps.config;
	pi.registerTool({
		name: "notes",
		label: "Notes",
		description:
			'Read and maintain private notes that survive context-window resets within this session. Paths are virtual, not filesystem paths (e.g. "checkpoint.md"). Reads reflect writes immediately; page long files by lines (start_line/stop_line) or by chars (offset_chars/limit_chars). Files must stay at or below 1,000,000 bytes; create another file before approaching the limit. ' +
			TOOL_PRIVATE_USAGE_HINT,
		promptSnippet: "Persistent private notes across context windows (notes).",
		parameters: NOTES_PARAMS,
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const notes = deps.getNotes();
			const op = params.operation as string;
			try {
				switch (op) {
					case "write": {
						const p = requiredString(params.path, "path");
						const text = requiredString(params.text, "text");
						notes.writeFile(p, text);
						return textResult(`Wrote ${Buffer.byteLength(text, "utf8")} bytes to ${p}.`, config);
					}
					case "append": {
						const p = requiredString(params.path, "path");
						const text = requiredString(params.text, "text");
						notes.appendToFile(p, text);
						return textResult(`Appended ${Buffer.byteLength(text, "utf8")} bytes to ${p}.`, config);
					}
					case "read": {
						const p = requiredString(params.path, "path");
						const start = optionalInt(params.start_line);
						const stop = optionalInt(params.stop_line);
						const offset = params.offset_chars !== undefined ? clampInt(params.offset_chars, 0, 10_000_000, 0) : 0;
						const limitChars = clampInt(params.limit_chars, 1, config.maxToolOutputChars, config.maxToolOutputChars);
						const { content, totalChars } = notes.readFile(p, start, stop, offset, limitChars);
						const end = offset + content.length;
						const header =
							offset === 0 && end === totalChars
								? `--- ${p} (${totalChars} chars) ---`
								: `--- ${p} (${totalChars} chars total, showing ${offset}..${end}${end < totalChars ? `; next offset_chars=${end}` : ""}) ---`;
						return textResult(`${header}\n${content}`, config);
					}
					case "search": {
						const query = requiredString(params.query, "query");
						const matches = notes.searchContents(
							query,
							optionalString(params.prefix),
							params.max_files !== undefined ? clampInt(params.max_files, 1, 500, 50) : 50,
							params.max_matches_per_file !== undefined ? clampInt(params.max_matches_per_file, 1, 100, 10) : 10,
						);
						if (matches.length === 0) return textResult(`No matches for "${query}".`, config);
						return textResult(matches.map((m) => `${m.path}:${m.line}: ${truncate(m.text, 300)}`).join("\n"), config);
					}
					case "list": {
						const files = notes.listFiles(
							optionalString(params.prefix),
							params.max_results !== undefined ? clampInt(params.max_results, 1, 500, 100) : 100,
						);
						if (files.length === 0) return textResult("No note files.", config);
						const lines = files.map((f) => `${f.path} (${f.bytes} bytes, updated ${f.updatedAt})`);
						return textResult([...lines, ...notesBloatWarnings(() => notes, config)].join("\n"), config);
					}
					default:
						return textResult(`Unknown operation "${String(op)}".`, config);
				}
			} catch (err) {
				return textResult(`notes ${op} failed: ${err instanceof Error ? err.message : String(err)}`, config);
			}
		},
	});
}
