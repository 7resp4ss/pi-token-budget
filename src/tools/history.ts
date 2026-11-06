/** Four independent history tools, each with its own Codex schema. */
import type { HistoryFilters } from "../stores/history-store.ts";
import { charLength } from "../storage.ts";
import { defineTool, integerArg, pageResult, requiredString, rowsResult, type ToolDeps, type ToolRegistrar } from "./deps.ts";

export function registerHistoryTool(pi: ToolRegistrar, deps: ToolDeps): void {
	const config = deps.config;
	// Indexes have a tighter budget than explicit item reads. Reserve room for
	// JSON escaping and match coordinates without cutting a record in half.
	const indexConfig = { ...config, maxToolOutputChars: Math.min(6000, config.maxToolOutputChars) };
	const nullableString = (v: unknown) => typeof v === "string" ? v : undefined;
	const filters = (params: Record<string, unknown>, defaultLimit: number): HistoryFilters => ({
		windowId: nullableString(params.window_id), role: nullableString(params.role),
		toolNamespace: nullableString(params.tool_namespace), toolName: nullableString(params.tool_name),
		limit: integerArg(params, "limit", defaultLimit, 200), recentFirst: params.recent_first === true,
		previewChars: integerArg(params, "max_chars_per_item", config.historyItemPreviewChars, Math.max(1, Math.floor((indexConfig.maxToolOutputChars - 1800) / 6))),
		// Targeted tool filters can inspect bookkeeping too. Ordinary recovery
		// excludes self-referential history/notes calls and budget controls.
		scope: typeof params.tool_namespace === "string" || typeof params.tool_name === "string" ? "all" : "task",
	});
	const agent = (params: Record<string, unknown>) => deps.getTask().resolve(params.agent_name as string | null | undefined).agentName;
	const ownCall = (name: string, id: string) => name === deps.getTask().agent.agentName ? id : undefined;
	defineTool(pi, "history_list_windows", async (params, ctx, id) => {
		const name = agent(params);
		const windows = deps.buildHistory(ctx, name).listWindows(integerArg(params, "limit", 50, 200), params.recent_first === true, ownCall(name, id));
		return rowsResult(windows.map(w => `${w.windowId}: ${w.itemCount} items (${w.taskItems} task items)`), indexConfig, `History windows for ${name}`);
	});
	defineTool(pi, "history_list_items", async (params, ctx, id) => {
		const name = agent(params);
		const items = deps.buildHistory(ctx, name).listItems({ ...filters(params, 50), excludedToolCallId: ownCall(name, id) });
		return rowsResult(items.map(i => JSON.stringify({ agent_name: name, window_id: i.windowId, item_id: i.itemId, role: i.role, chars: i.chars, image_count: i.imageCount, truncated_content: i.preview, ...(i.source ? { source: i.source } : {}) })), indexConfig, `${items.length} matching history items`);
	});
	defineTool(pi, "history_read_item", async (params, ctx) => {
		const name = agent(params);
		const window = requiredString(params.window_id, "window_id");
		const id = requiredString(params.item_id, "item_id");
		const limit = integerArg(params, "limit_chars", config.maxToolOutputChars, Math.max(1, config.maxToolOutputChars - charLength(name) - charLength(id) - 240));
		const item = deps.buildHistory(ctx, name).readItem(id, integerArg(params, "offset_chars", 0), limit, window);
		const imageCapable = ctx.model?.input.includes("image") ?? true;
		const result = pageResult(`[${id}] (${name}/${window}/${item.role}, ${item.totalChars} chars total, showing ${item.offset}..${item.end}${item.end < item.totalChars ? `; next offset_chars=${item.end}` : ""})${item.images.length ? `; ${item.images.length} image(s)${imageCapable ? " attached" : "; current model accepts text only"}` : ""}:\n${item.text}`, { totalChars: item.totalChars, offset: item.offset, end: item.end, imageCount: item.images.length, imageCapable });
		return { ...result, content: [...result.content, ...(imageCapable ? item.images : [])] };
	});
	defineTool(pi, "history_search_contents", async (params, ctx, id) => {
		const name = agent(params);
		const matches = deps.buildHistory(ctx, name).searchContents(requiredString(params.query, "query"), { ...filters(params, 20), excludedToolCallId: ownCall(name, id) });
		return rowsResult(matches.map(m => JSON.stringify({ agent_name: name, window_id: m.windowId, item_id: m.itemId, role: m.role, chars: m.totalChars, truncated_content: m.preview,
			regions: m.regions.map(r => ({ matches: r.matches, offset_chars: r.readOffset, limit_chars: r.readLimit })), more_matches_in_item: m.moreMatchesInItem,
			...(m.source ? { source: m.source } : {}),
		})), indexConfig, `${matches.length} matching history items`);
	});
}
