/** Single model-facing history recovery tool with strict per-operation validation. */

import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	HistoryContentKind,
	HistoryKind,
	HistoryListItem,
	HistoryScope,
	HistorySearchItem,
	HistorySource,
	HistoryWindow,
} from "../stores/history-store.ts";
import { truncate } from "../stores/history-store.ts";
import { TOOL_PRIVATE_USAGE_HINT } from "../prompts.ts";
import { errorResult, textResult, type ToolDeps, type ToolRegistrar } from "./deps.ts";

const OPERATIONS = ["list_windows", "list_items", "search_contents", "read_item"] as const;
type HistoryOperation = (typeof OPERATIONS)[number];
type CursorOperation = Exclude<HistoryOperation, "read_item">;

const ROLE_VALUES = ["user", "assistant", "toolResult", "custom", "bashExecution", "compaction", "branchSummary"] as const;
const KIND_VALUES = ["message", "tool_call", "tool_result", "all"] as const;
const SCOPE_VALUES = ["task", "all"] as const;

const HISTORY_PARAMS = Type.Object(
	{
		operation: Type.Union(OPERATIONS.map((operation) => Type.Literal(operation)), {
			description:
				"Choose one operation: read_item when item_id is known; search_contents when a literal phrase is known but its id is not; list_items to browse conversation; list_windows only to discover window ids.",
		}),
		item_id: Type.Optional(Type.String({ description: "Exact opaque id returned by notes, bootstrap, list, or search. Required for read_item; never guess.", minLength: 1 })),
		query: Type.Optional(
			Type.String({ description: "Case-sensitive literal for search_contents. Literal matching is not semantic relevance; revise an empty search instead of repeating it.", minLength: 1, maxLength: 1024 }),
		),
		window_id: Type.Optional(Type.String({ description: "Exact window id from list_windows.", minLength: 1 })),
		role: Type.Optional(Type.Union(ROLE_VALUES.map((role) => Type.Literal(role)), { description: "Optional session-role filter." })),
		kind: Type.Optional(
			Type.Union(KIND_VALUES.map((kind) => Type.Literal(kind)), {
				description:
					'Content filter. list_items defaults to "message"; search_contents defaults to "all". Use "tool_result" for command output and "tool_call" for arguments.',
			}),
		),
		scope: Type.Optional(
			Type.Union(SCOPE_VALUES.map((scope) => Type.Literal(scope)), {
				description: '"task" (default) hides internal recovery records; "all" includes them for diagnostics.',
			}),
		),
		tool_name: Type.Optional(
			Type.String({
				description:
					'Exact tool-name filter. Without kind it implies kind="tool_result". With kind="all" it searches matching calls and results. Use "unknown" for unassociated results.',
				minLength: 1,
				maxLength: 256,
			}),
		),
		limit: Type.Optional(Type.Integer({ description: "Result-record limit for list_items/search_contents (not a character count).", minimum: 1, maximum: 200 })),
		recent_first: Type.Optional(Type.Boolean({ description: "Return newest records first. Defaults true for list and search." })),
		offset_chars: Type.Optional(Type.Integer({ description: "UTF-16 offset for read_item, copied from a search read_offset when available.", minimum: 0 })),
		limit_chars: Type.Optional(
			Type.Integer({ description: "Body-character limit for read_item (default 2000; not a result count).", minimum: 1, maximum: 100_000 }),
		),
		cursor: Type.Optional(
			Type.String({
				description: "Opaque next_cursor returned by the same operation. In cursor mode pass only operation and cursor; copy it unchanged.",
				minLength: 1,
				maxLength: 32_768,
			}),
		),
	},
	{ additionalProperties: false },
);

interface NormalizedFilters {
	windowId?: string;
	role?: string;
	kind: HistoryKind;
	scope: HistoryScope;
	toolName?: string;
	limit: number;
	recentFirst: boolean;
	query?: string;
}

interface CursorPayload {
	version: 1;
	sessionId: string;
	snapshotLeafId: string;
	operation: CursorOperation;
	filters: NormalizedFilters;
	afterId: string;
	excludedToolCallId: string;
}

interface CursorEnvelope {
	payload: CursorPayload;
	checksum: string;
}

interface PageRecord {
	id: string;
	format(bodyLimit?: number): string;
	details: Record<string, unknown>;
}

class HistoryToolError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

function asObject(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryToolError("invalid_cursor", `${name} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
	const allowed = new Set(keys);
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	const missing = keys.filter((key) => !(key in value));
	if (unknown.length > 0 || missing.length > 0) {
		throw new HistoryToolError(
			"invalid_cursor",
			`${name} shape mismatch${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`,
		);
	}
}

function checksum(payload: CursorPayload): string {
	return createHash("sha256").update(JSON.stringify(payload)).digest("base64url");
}

function encodeCursor(payload: CursorPayload): string {
	const envelope: CursorEnvelope = { payload, checksum: checksum(payload) };
	return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
	try {
		const envelope = asObject(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")), "cursor") as unknown as CursorEnvelope;
		exactKeys(envelope as unknown as Record<string, unknown>, ["payload", "checksum"], "cursor");
		const payload = asObject(envelope.payload, "cursor.payload") as unknown as CursorPayload;
		exactKeys(payload as unknown as Record<string, unknown>, ["version", "sessionId", "snapshotLeafId", "operation", "filters", "afterId", "excludedToolCallId"], "cursor.payload");
		if (payload.version !== 1) throw new HistoryToolError("invalid_cursor", "unsupported cursor version");
		if (!OPERATIONS.includes(payload.operation as HistoryOperation) || (payload.operation as string) === "read_item") {
			throw new HistoryToolError("invalid_cursor", "cursor operation is invalid");
		}
		for (const [name, value] of [
			["sessionId", payload.sessionId],
			["snapshotLeafId", payload.snapshotLeafId],
			["afterId", payload.afterId],
			["excludedToolCallId", payload.excludedToolCallId],
		] as const) {
			if (typeof value !== "string" || value.length === 0) throw new HistoryToolError("invalid_cursor", `${name} must be a non-empty string`);
		}
		const filters = asObject(payload.filters, "cursor.filters") as unknown as NormalizedFilters;
		const filterKeys = ["kind", "scope", "limit", "recentFirst"];
		if (payload.operation === "search_contents") filterKeys.push("query");
		for (const optional of ["windowId", "role", "toolName"]) if (optional in filters) filterKeys.push(optional);
		exactKeys(filters as unknown as Record<string, unknown>, filterKeys, "cursor.filters");
		if (!KIND_VALUES.includes(filters.kind)) throw new HistoryToolError("invalid_cursor", "cursor kind is invalid");
		if (!SCOPE_VALUES.includes(filters.scope)) throw new HistoryToolError("invalid_cursor", "cursor scope is invalid");
		if (!Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > 200) throw new HistoryToolError("invalid_cursor", "cursor limit is invalid");
		if (typeof filters.recentFirst !== "boolean") throw new HistoryToolError("invalid_cursor", "cursor order is invalid");
		if (filters.role !== undefined && !ROLE_VALUES.includes(filters.role as (typeof ROLE_VALUES)[number])) throw new HistoryToolError("invalid_cursor", "cursor role is invalid");
		for (const [name, value] of [["windowId", filters.windowId], ["toolName", filters.toolName], ["query", filters.query]] as const) {
			if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) throw new HistoryToolError("invalid_cursor", `cursor ${name} is invalid`);
		}
		if (filters.toolName !== undefined && filters.toolName.length > 256) throw new HistoryToolError("invalid_cursor", "cursor toolName is too long");
		if (filters.query !== undefined && filters.query.length > 1024) throw new HistoryToolError("invalid_cursor", "cursor query is too long");
		if (payload.operation === "search_contents" && typeof filters.query !== "string") throw new HistoryToolError("invalid_cursor", "cursor query is missing");
		if (typeof envelope.checksum !== "string" || envelope.checksum !== checksum(payload)) throw new HistoryToolError("invalid_cursor", "cursor checksum mismatch");
		return payload;
	} catch (error) {
		if (error instanceof HistoryToolError) throw error;
		throw new HistoryToolError("invalid_cursor", `cursor could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function rejectUnknown(params: Record<string, unknown>, allowed: readonly string[]): void {
	const allowedSet = new Set(allowed);
	const unknown = Object.keys(params).filter((key) => !allowedSet.has(key));
	if (unknown.length > 0) throw new HistoryToolError("invalid_arguments", `unknown parameter(s) for ${String(params.operation)}: ${unknown.join(", ")}`);
}

function requiredOperation(value: unknown): HistoryOperation {
	if (typeof value !== "string" || !OPERATIONS.includes(value as HistoryOperation)) {
		throw new HistoryToolError("invalid_arguments", `operation must be one of: ${OPERATIONS.join(", ")}`);
	}
	return value as HistoryOperation;
}

function optionalString(value: unknown, name: string, maxLength?: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) throw new HistoryToolError("invalid_arguments", `${name} must be a non-blank string`);
	if (maxLength !== undefined && value.length > maxLength) throw new HistoryToolError("invalid_arguments", `${name} must be at most ${maxLength} characters`);
	return value;
}

function requiredText(value: unknown, name: string, maxLength?: number): string {
	const text = optionalString(value, name, maxLength);
	if (text === undefined) throw new HistoryToolError("invalid_arguments", `${name} is required and cannot be blank`);
	return text;
}

function optionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback: T): T {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new HistoryToolError("invalid_arguments", `${name} must be one of: ${allowed.join(", ")}`);
	return value as T;
}

function optionalInteger(value: unknown, name: string, fallback: number, minimum: number, maximum?: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value)) throw new HistoryToolError("invalid_arguments", `${name} must be a safe integer`);
	const number = value as number;
	if (number < minimum || (maximum !== undefined && number > maximum)) {
		throw new HistoryToolError("invalid_arguments", `${name} must be between ${minimum} and ${maximum ?? "the safe-integer maximum"}`);
	}
	return number;
}

function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new HistoryToolError("invalid_arguments", `${name} must be a boolean`);
	return value;
}

function normalizeFilters(operation: "list_items" | "search_contents", params: Record<string, unknown>): NormalizedFilters {
	const windowId = optionalString(params.window_id, "window_id");
	const toolName = optionalString(params.tool_name, "tool_name", 256);
	const explicitKind = params.kind !== undefined;
	let kind = optionalEnum(params.kind, "kind", KIND_VALUES, operation === "list_items" ? "message" : "all") as HistoryKind;
	if (toolName !== undefined && !explicitKind) kind = "tool_result";
	if (toolName !== undefined && kind === "message") {
		throw new HistoryToolError("invalid_arguments", 'tool_name conflicts with kind="message"; use tool_result, tool_call, or all');
	}
	const query = operation === "search_contents" ? requiredText(params.query, "query", 1024) : undefined;
	return {
		...(windowId ? { windowId } : {}),
		...(params.role !== undefined ? { role: optionalEnum(params.role, "role", ROLE_VALUES, "user") } : {}),
		kind,
		scope: optionalEnum(params.scope, "scope", SCOPE_VALUES, "task"),
		...(toolName ? { toolName } : {}),
		limit: optionalInteger(params.limit, "limit", operation === "list_items" ? 20 : 10, 1, 200),
		recentFirst: optionalBoolean(params.recent_first, "recent_first", true),
		...(query !== undefined ? { query } : {}),
	};
}

function sourceLabel(source: HistorySource | undefined): string {
	if (!source) return "";
	return ` tool_name=${source.toolName ?? "unknown"}${source.assistantItemId ? ` assistant_item_id=${source.assistantItemId}` : ""}`;
}

function kindsLabel(kinds: HistoryContentKind[]): string {
	return kinds.join("+") || "unknown";
}

function shorten(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	return truncate(text, maxChars);
}

function listRecord(item: HistoryListItem): PageRecord {
	const label = `[${item.itemId}] ${item.windowId}/${item.role} kind=${kindsLabel(item.kinds)} total_chars=${item.totalChars}${sourceLabel(item.source)}${item.internal ? " internal=true" : ""}`;
	return {
		id: item.itemId,
		format: (bodyLimit) => {
			const preview = bodyLimit === undefined ? item.preview : shorten(item.preview, bodyLimit);
			return preview.length > 0 ? `${label}\n${preview}` : label;
		},
		details: { itemId: item.itemId, windowId: item.windowId, role: item.role, kinds: item.kinds, totalChars: item.totalChars, source: item.source, internal: item.internal },
	};
}

function formatSearchRegion(region: HistorySearchItem["regions"][number], bodyLimit: number | undefined): string {
	let start = region.excerptStart;
	let end = region.excerptEnd;
	if (bodyLimit !== undefined && end - start > bodyLimit) {
		const match = region.matches[0];
		const visibleMatchLength = Math.min(bodyLimit, match.end - match.start);
		const before = Math.max(0, Math.floor((bodyLimit - visibleMatchLength) / 2));
		start = Math.max(region.excerptStart, match.start - before);
		end = Math.min(region.excerptEnd, start + bodyLimit);
		start = Math.max(region.excerptStart, end - bodyLimit);
	}
	const shown = region.text.slice(start - region.excerptStart, end - region.excerptStart);
	const matches = region.matches.map((match) => `${match.start}..${match.end}`).join(",");
	const prefix = region.prefixOmitted || start > region.excerptStart ? "…" : "";
	const suffix = region.suffixOmitted || end < region.excerptEnd ? "…" : "";
	return `matches=${matches} excerpt=${start}..${end} read_offset=${start} read_limit=${shown.length}\n${prefix}${shown}${suffix}`;
}

function searchRecord(item: HistorySearchItem): PageRecord {
	const label = `[${item.itemId}] ${item.windowId}/${item.role} kind=${kindsLabel(item.kinds)} total_chars=${item.totalChars}${sourceLabel(item.source)}${item.internal ? " internal=true" : ""}`;
	return {
		id: item.itemId,
		format: (bodyLimit) => {
			const perRegion = bodyLimit === undefined ? undefined : Math.max(0, Math.floor(bodyLimit / Math.max(1, item.regions.length)));
			const regions = item.regions.map((region) => formatSearchRegion(region, perRegion));
			if (item.moreMatchesInItem) regions.push("more_matches_in_item=true");
			return regions.length > 0 ? `${label}\n${regions.join("\n")}` : label;
		},
		details: {
			itemId: item.itemId,
			windowId: item.windowId,
			role: item.role,
			kinds: item.kinds,
			totalChars: item.totalChars,
			regions: item.regions,
			moreMatchesInItem: item.moreMatchesInItem,
			source: item.source,
			internal: item.internal,
		},
	};
}

function windowRecord(window: HistoryWindow): PageRecord {
	return {
		id: window.windowId,
		format: () => `${window.windowId}: task_items=${window.taskItems}, all_items=${window.allItems}${window.openedByCompaction ? " (opened by rollover)" : ""}`,
		details: window as unknown as Record<string, unknown>,
	};
}

function filtersLabel(filters: NormalizedFilters): string {
	const parts = [
		`scope=${filters.scope}`,
		`kind=${filters.kind}`,
		`order=${filters.recentFirst ? "recent" : "oldest"}`,
		filters.windowId ? `window=${filters.windowId}` : undefined,
		filters.role ? `role=${filters.role}` : undefined,
		filters.toolName ? `tool_name=${filters.toolName}` : undefined,
	].filter(Boolean);
	return parts.join(" ");
}

function pageText(
	operation: CursorOperation,
	headerBase: string,
	records: PageRecord[],
	hasMoreAfterRecords: boolean,
	budget: number,
	makeCursor: (afterId: string) => string,
): { text: string; delivered: PageRecord[]; nextCursor?: string } {
	if (records.length === 0) {
		const text = `${headerBase} returned=0 more=false\nNo matching history records.`;
		if (text.length > budget) throw new HistoryToolError("output_budget_too_small", `${operation} output budget is too small for its header`);
		return { text, delivered: [] };
	}
	let best: { text: string; delivered: PageRecord[]; nextCursor?: string } | undefined;
	for (let count = 1; count <= records.length; count++) {
		const delivered = records.slice(0, count);
		const more = hasMoreAfterRecords || count < records.length;
		const nextCursor = more ? makeCursor(delivered.at(-1)!.id) : undefined;
		const header = `${headerBase} returned=${count} more=${more}`;
		const footer = nextCursor ? `\n\nnext_cursor=${nextCursor}` : "";
		const text = `${header}\n${delivered.map((record) => record.format()).join("\n\n")}${footer}`;
		if (text.length <= budget) best = { text, delivered, ...(nextCursor ? { nextCursor } : {}) };
		else break;
	}
	if (best) return best;
	for (const bodyLimit of [120, 80, 40, 0]) {
		const delivered = [records[0]];
		const more = hasMoreAfterRecords || records.length > 1;
		const nextCursor = more ? makeCursor(records[0].id) : undefined;
		const header = `${headerBase} returned=1 more=${more}`;
		const footer = nextCursor ? `\n\nnext_cursor=${nextCursor}` : "";
		const text = `${header}\n${records[0].format(bodyLimit)}${footer}`;
		if (text.length <= budget) return { text, delivered, ...(nextCursor ? { nextCursor } : {}) };
	}
	throw new HistoryToolError("output_budget_too_small", `${operation} output budget is too small for one complete record and its continuation metadata`);
}

function operationExample(operation: HistoryOperation): string {
	switch (operation) {
		case "list_windows":
			return '{"operation":"list_windows"}';
		case "list_items":
			return '{"operation":"list_items","role":"user"}';
		case "search_contents":
			return '{"operation":"search_contents","query":"exact text"}';
		case "read_item":
			return 'first locate an id with list_items/search_contents, then call {"operation":"read_item","item_id":"<returned-id>"}';
	}
}

function historyError(error: unknown, operation: HistoryOperation | undefined, config: ToolDeps["config"]) {
	const code = error instanceof HistoryToolError ? error.code : "history_error";
	const message = error instanceof Error ? error.message : String(error);
	const correction = operation ? ` Correct form: ${operationExample(operation)}.` : "";
	const result = errorResult(`history ${operation ?? "request"} failed [${code}]: ${message}.${correction}`, config);
	return { ...result, details: { error: true, errorCode: code, operation } };
}

function validateCursorSnapshot(payload: CursorPayload, ctx: ExtensionContext): void {
	if (payload.sessionId !== ctx.sessionManager.getSessionId()) throw new HistoryToolError("cursor_session_mismatch", "cursor belongs to another session");
	const currentBranch = ctx.sessionManager.getBranch() as Array<{ id?: string }>;
	if (!currentBranch.some((entry) => entry.id === payload.snapshotLeafId)) {
		throw new HistoryToolError("cursor_stale_branch", "cursor snapshot is not an ancestor of the current branch; restart the query without cursor");
	}
}

export function registerHistoryTool(pi: ToolRegistrar, deps: ToolDeps): void {
	const config = deps.config;
	const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
	pi.registerTool({
		name: "history",
		label: "History",
		description:
			"Recover missing details from the current session. Choose by what you already know: item id -> read_item; literal phrase but no id -> search_contents; neither -> list_items; unknown window -> list_windows. list_items defaults to user/assistant messages. search_contents also checks ordinary tool evidence, but returns only short located excerpts; change or narrow an empty search instead of repeating it. Use kind/tool_name to narrow sources. limit counts records; limit_chars counts UTF-16 characters. Copy returned item ids, offsets, and cursors exactly; never guess them. " +
			TOOL_PRIVATE_USAGE_HINT,
		promptSnippet: "Browse, search, or read bounded current-session history (history).",
		parameters: HISTORY_PARAMS,
		annotations,
		async execute(toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			let operation: HistoryOperation | undefined;
			try {
				operation = requiredOperation(params.operation);
				const cursorText = optionalString(params.cursor, "cursor", 32_768);
				if (cursorText !== undefined) {
					if (operation === "read_item") throw new HistoryToolError("invalid_arguments", "read_item does not accept cursor; use offset_chars and limit_chars");
					rejectUnknown(params, ["operation", "cursor"]);
				}

				if (operation === "read_item") {
					rejectUnknown(params, ["operation", "item_id", "offset_chars", "limit_chars"]);
					const itemId = requiredText(params.item_id, "item_id");
					const offset = optionalInteger(params.offset_chars, "offset_chars", 0, 0);
					const requested = Math.min(optionalInteger(params.limit_chars, "limit_chars", 2000, 1, 100_000), config.maxToolOutputChars);
					const item = deps.buildHistory(ctx).readItem(itemId, offset, requested);
					let body = item.text;
					const format = () => {
						const end = offset + body.length;
						const next = end < item.totalChars ? `\nnext_offset_chars=${end}` : "";
						return `[${item.itemId}] ${item.windowId}/${item.role} total_chars=${item.totalChars} showing=${offset}..${end}${sourceLabel(item.source)}\n${body}${next}`;
					};
					while (body.length > 0 && format().length > config.maxToolOutputChars) body = body.slice(0, body.length - Math.max(1, format().length - config.maxToolOutputChars));
					if (format().length > config.maxToolOutputChars) throw new HistoryToolError("output_budget_too_small", "read_item output budget is too small for metadata");
					const result = textResult(format(), config);
					return {
						...result,
						details: {
							operation,
							itemId: item.itemId,
							totalChars: item.totalChars,
							showing: [offset, offset + body.length],
							nextOffsetChars: offset + body.length < item.totalChars ? offset + body.length : undefined,
							source: item.source,
						},
					};
				}

				let cursor: CursorPayload | undefined;
				let filters: NormalizedFilters;
				let snapshotLeafId: string;
				let excludedToolCallId: string;
				let afterId: string | undefined;
				if (cursorText !== undefined) {
					cursor = decodeCursor(cursorText);
					if (cursor.operation !== operation) throw new HistoryToolError("cursor_operation_mismatch", `cursor belongs to ${cursor.operation}`);
					validateCursorSnapshot(cursor, ctx);
					filters = cursor.filters;
					snapshotLeafId = cursor.snapshotLeafId;
					excludedToolCallId = cursor.excludedToolCallId;
					afterId = cursor.afterId;
				} else {
					snapshotLeafId = ctx.sessionManager.getLeafId() ?? "";
					if (snapshotLeafId.length === 0) throw new HistoryToolError("snapshot_unavailable", "session branch has no snapshot leaf");
					excludedToolCallId = toolCallId;
					if (operation === "list_windows") {
						rejectUnknown(params, ["operation"]);
						filters = { kind: "all", scope: "task", limit: 200, recentFirst: false };
					} else {
						rejectUnknown(params, ["operation", "window_id", "role", "kind", "scope", "tool_name", "limit", "recent_first", ...(operation === "search_contents" ? ["query"] : [])]);
						filters = normalizeFilters(operation, params);
					}
				}

				const history = deps.buildHistory(ctx, snapshotLeafId);
				const indexBudget = Math.min(config.maxToolOutputChars, 6000);
				const cursorFor = (id: string): string =>
					encodeCursor({
						version: 1,
						sessionId: ctx.sessionManager.getSessionId(),
						snapshotLeafId,
						operation: operation as CursorOperation,
						filters,
						afterId: id,
						excludedToolCallId,
					});

				let page: ReturnType<typeof pageText>;
				if (operation === "list_windows") {
					let windows = history.listWindows(excludedToolCallId);
					if (afterId !== undefined) {
						const index = windows.findIndex((window) => window.windowId === afterId);
						if (index < 0) throw new HistoryToolError("cursor_position_missing", `window ${afterId} is absent from the snapshot`);
						windows = windows.slice(index + 1);
					}
					page = pageText(operation, "history list_windows", windows.map(windowRecord), false, indexBudget, cursorFor);
				} else if (operation === "list_items") {
					const previewChars = Math.min(config.historyItemPreviewChars, filters.kind === "message" ? 240 : 160);
					const items = history.listItems({
						windowId: filters.windowId,
						role: filters.role,
						kind: filters.kind,
						scope: filters.scope,
						toolName: filters.toolName,
						limit: filters.limit + 1,
						recentFirst: filters.recentFirst,
						afterItemId: afterId,
						previewChars,
						excludedToolCallId,
					});
					const hasMore = items.length > filters.limit;
					page = pageText(operation, `history list_items ${filtersLabel(filters)}`, items.slice(0, filters.limit).map(listRecord), hasMore, indexBudget, cursorFor);
				} else {
					const excerptChars = Math.min(config.historyItemPreviewChars, 240);
					const matches = history.searchContents(filters.query!, {
						windowId: filters.windowId,
						role: filters.role,
						kind: filters.kind,
						scope: filters.scope,
						toolName: filters.toolName,
						limit: filters.limit + 1,
						recentFirst: filters.recentFirst,
						afterItemId: afterId,
						excerptChars,
						excludedToolCallId,
					});
					const hasMore = matches.length > filters.limit;
					const shownQuery = JSON.stringify(filters.query!.length > 80 ? `${filters.query!.slice(0, 80)}…` : filters.query);
					page = pageText(operation, `history search_contents ${filtersLabel(filters)} query=${shownQuery}`, matches.slice(0, filters.limit).map(searchRecord), hasMore, indexBudget, cursorFor);
				}
				const result = textResult(page.text, config);
				return {
					...result,
					details: {
						operation,
						snapshotLeafId,
						filters,
						returned: page.delivered.length,
						nextCursor: page.nextCursor,
						records: page.delivered.map((record) => record.details),
					},
				};
			} catch (error) {
				return historyError(error, operation, config);
			}
		},
	});
}
