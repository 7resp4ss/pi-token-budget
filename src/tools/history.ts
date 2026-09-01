/**
 * Tool: history
 * ==============
 * Read-only random access to prior context windows, built over the session
 * tree (src/stores/history-store.ts). Old windows are never deleted from the
 * session file — after a rollover they become addressable "cold storage",
 * retrieved on demand by opaque item id.
 *
 * Operations (mirrors codex's history namespace):
 *   list_windows    — window ids with item counts (metadata only, no content)
 *   list_items      — filtered item listing with truncated_content previews
 *   read_item       — character-level ranged read of ONE item (item_id required)
 *   search_contents — literal substring search across items
 *
 * Anti-explosion guarantees (see README "Invariants"):
 * every read is paginated at the parameter level and every output is
 * truncated to maxToolOutputChars — no operation can return unbounded
 * content.
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TOOL_PRIVATE_USAGE_HINT } from "../prompts.ts";
import { clampInt, optionalString, requiredString, textResult, type ToolDeps, type ToolRegistrar } from "./deps.ts";

const HISTORY_PARAMS = Type.Object({
	operation: Type.Union(
		[
			Type.Literal("list_windows"),
			Type.Literal("list_items"),
			Type.Literal("read_item"),
			Type.Literal("search_contents"),
		],
		{ description: "Which history operation to run." },
	),
	item_id: Type.Optional(Type.String({ description: "Item id returned by list/search. Required for read_item." })),
	window_id: Type.Optional(Type.String({ description: "Window id from list_windows. Optional filter." })),
	query: Type.Optional(Type.String({ description: "Literal substring for search_contents." })),
	role: Type.Optional(Type.String({ description: "Optional role filter: user | assistant | toolResult | custom | compaction." })),
	offset_chars: Type.Optional(Type.Integer({ description: "Zero-based char offset for read_item.", minimum: 0 })),
	limit_chars: Type.Optional(
		Type.Integer({
			description: "Max chars to return for read_item. Clamped to the tool output cap, so the returned range is always shown in full.",
			minimum: 1,
			maximum: 100_000,
		}),
	),
	limit: Type.Optional(Type.Integer({ description: "Max items/matches to return.", minimum: 1, maximum: 200 })),
	recent_first: Type.Optional(Type.Boolean({ description: "Return most recent items first." })),
});

export function registerHistoryTool(pi: ToolRegistrar, deps: ToolDeps): void {
	const config = deps.config;
	pi.registerTool({
		name: "history",
		label: "History",
		description:
			"Recover prior conversation after a context-window reset: list windows and items, read a bounded range of one item, or search by literal substring. Item ids come from these tools (also recorded in your notes); pass them back unchanged. Read-only and eventually consistent. " +
			TOOL_PRIVATE_USAGE_HINT,
		promptSnippet: "Read-only recovery of prior context windows (history).",
		parameters: HISTORY_PARAMS,
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const history = deps.buildHistory(ctx);
			const op = params.operation as string;
			try {
				switch (op) {
					case "list_windows": {
						const windows = history.listWindows();
						if (windows.length === 0) return textResult("No history windows yet.", config);
						return textResult(
							windows.map((w) => `${w.windowId}: ${w.itemCount} items${w.openedByCompaction ? " (opened by rollover)" : ""}`).join("\n"),
							config,
						);
					}
					case "list_items": {
						const items = history.listItems({
							windowId: optionalString(params.window_id),
							role: optionalString(params.role),
							limit: params.limit !== undefined ? clampInt(params.limit, 1, 200, 50) : undefined,
							recentFirst: params.recent_first === true,
							previewChars: config.historyItemPreviewChars,
						});
						if (items.length === 0) return textResult("No matching history items.", config);
						return textResult(
							items.map((i) => `[${i.itemId}] (${i.windowId}/${i.role}, ${i.chars} chars): ${i.preview}`).join("\n\n"),
							config,
						);
					}
					case "read_item": {
						const itemId = requiredString(params.item_id, "item_id");
						const offset = params.offset_chars !== undefined ? clampInt(params.offset_chars, 0, 10_000_000, 0) : 0;
						const limitChars = clampInt(params.limit_chars, 1, config.maxToolOutputChars, config.maxToolOutputChars);
						const item = history.readItem(itemId, offset, limitChars);
						return textResult(
							`[${item.itemId}] (${item.windowId}/${item.role}, ${item.totalChars} chars total, showing ${offset}..${offset + item.text.length}):\n${item.text}`,
							config,
						);
					}
					case "search_contents": {
						const query = requiredString(params.query, "query");
						const matches = history.searchContents(query, {
							windowId: optionalString(params.window_id),
							role: optionalString(params.role),
							limit: params.limit !== undefined ? clampInt(params.limit, 1, 200, 20) : 20,
							recentFirst: params.recent_first === true,
							previewChars: config.historyItemPreviewChars,
						});
						if (matches.length === 0) return textResult(`No matches for "${query}".`, config);
						return textResult(matches.map((m) => `[${m.itemId}] (${m.windowId}/${m.role}): ${m.preview}`).join("\n\n"), config);
					}
					default:
						return textResult(`Unknown operation "${String(op)}".`, config);
				}
			} catch (err) {
				return textResult(`history ${op} failed: ${err instanceof Error ? err.message : String(err)}`, config);
			}
		},
	});
}
