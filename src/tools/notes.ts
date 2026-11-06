/** Five independent note tools. Paths resolve through the task registry, so
 * absolute paths can access only agents registered to the same root task. */
import { NotesStore } from "../stores/notes-store.ts";
import { charLength } from "../storage.ts";
import { defineTool, integerArg, notesBloatWarnings, pageResult, requiredString, rowsResult, textResult, type ToolDeps, type ToolRegistrar } from "./deps.ts";

export function registerNotesTool(pi: ToolRegistrar, deps: ToolDeps): void {
	const config = deps.config;
	const resolve = (input: string | undefined | null, prefix = false) => {
		const task = deps.getTask();
		const target = task.resolveNote(input, prefix);
		const store = target.agent.agentName === task.agent.agentName ? deps.getNotes()
			: new NotesStore("", "", config.notesMaxFileBytes, target.agent.notesRoot);
		return { ...target, store, canonical: `${target.agent.agentName}/notes${target.localPath ? `/${target.localPath}` : ""}` };
	};
	defineTool(pi, "notes_list_files_by_prefix", async params => {
		const target = resolve(params.prefix as string | null | undefined, true);
		const files = target.store.listFiles(target.localPath, integerArg(params, "max_results", 100, 500),
			(params.file_order_by as "name" | "created_at" | "updated_at" | undefined) ?? "name",
			(params.file_order as "ascending" | "descending" | undefined) ?? "ascending");
		return rowsResult([...files.map(f => JSON.stringify({ path: `${target.agent.agentName}/notes/${f.path}`, bytes: f.bytes, created_at: f.createdAt, updated_at: f.updatedAt })), ...notesBloatWarnings(() => target.store, config)], config, `Notes for ${target.agent.agentName} (${files.length} files)`);
	});
	defineTool(pi, "notes_read_file", async params => {
		const target = resolve(requiredString(params.path, "path"));
		const requestedOffset = integerArg(params, "offset_chars", 0);
		const limit = integerArg(params, "limit_chars", config.maxToolOutputChars, Math.max(1, config.maxToolOutputChars - charLength(target.canonical) - 200));
		const read = target.store.readFile(target.localPath, params.start_line as number | undefined, params.stop_line as number | undefined, requestedOffset, limit);
		const offset = Math.min(requestedOffset, read.totalChars);
		const end = offset + charLength(read.content);
		return pageResult(`${target.canonical} (${read.totalChars} chars after line selection, showing ${offset}..${end}${end < read.totalChars ? `; next offset_chars=${end}` : ""})\n${read.content}`, { totalChars: read.totalChars, offset, end });
	});
	defineTool(pi, "notes_search_contents", async params => {
		const target = resolve(params.path_prefix as string | null | undefined, true);
		const matches = target.store.searchContents(requiredString(params.query, "query"), target.localPath,
			integerArg(params, "max_files", 50, 500), integerArg(params, "max_matches_per_file", 10, 100), params.recent_file_first === true);
		return rowsResult(matches.map(m => `${target.agent.agentName}/notes/${m.path}:${m.line}: ${m.text.slice(0, 300)}`), config, `${matches.length} matching note lines`);
	});
	const write = async (params: Record<string, unknown>, append: boolean) => {
		const target = resolve(requiredString(params.path, "path"));
		// Defend the checkpoint boundary even if execute is called without a host hook.
		const own = target.agent.agentName === deps.getTask().agent.agentName;
		if (deps.checkpointFenceActive() && !own) throw new Error("Checkpoint must be saved to the current agent's own notes");
		const text = params.text as string; // empty text is valid and validated by defineTool
		if (append) target.store.appendToFile(target.localPath, text);
		else target.store.writeFile(target.localPath, text);
		const result = textResult(`${append ? "Appended" : "Wrote"} ${Buffer.byteLength(text, "utf8")} bytes to ${target.canonical}.`, config);
		if (deps.checkpointFenceActive() && own) { deps.completeCheckpoint(); return { ...result, terminate: true }; }
		return result;
	};
	const failed = () => { if (deps.checkpointFenceActive()) deps.releaseCheckpointWrite(); };
	defineTool(pi, "notes_append_to_file", params => write(params, true), failed);
	defineTool(pi, "notes_write_file", params => write(params, false), failed);
}
