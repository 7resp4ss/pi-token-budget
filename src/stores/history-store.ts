/**
 * Read-only, window-segmented history over the live session branch.
 *
 * Each entry has one canonical safe text: structured thinking and nested
 * tool-result blocks never contribute. List/search select coordinate-bearing
 * segments from that canonical text, while readItem reads the same text by
 * UTF-16 offset. Session entry ids remain the only public item ids.
 */

import { BOOTSTRAP_MARKER, CUSTOM_TYPE_PREFIX } from "../prompts.ts";

export type HistoryScope = "task" | "all";
export type HistoryKind = "all" | "message" | "tool_call" | "tool_result";
export type HistoryContentKind = Exclude<HistoryKind, "all"> | "other";

export interface HistorySource {
	toolName?: string;
	toolCallId?: string;
	assistantItemId?: string;
}

export interface HistoryItem {
	itemId: string;
	windowId: string;
	role: string;
	text: string;
	source?: HistorySource;
}

export interface HistoryWindow {
	windowId: string;
	taskItems: number;
	allItems: number;
	openedByCompaction: boolean;
}

export interface HistoryListItem {
	itemId: string;
	windowId: string;
	role: string;
	preview: string;
	totalChars: number;
	projectedChars: number;
	kinds: HistoryContentKind[];
	internal: boolean;
	source?: HistorySource;
}

export interface HistoryMatch {
	start: number;
	end: number;
}

export interface HistorySearchRegion {
	matches: HistoryMatch[];
	excerptStart: number;
	excerptEnd: number;
	readOffset: number;
	readLimit: number;
	text: string;
	prefixOmitted: boolean;
	suffixOmitted: boolean;
}

export interface HistorySearchItem {
	itemId: string;
	windowId: string;
	role: string;
	totalChars: number;
	kinds: HistoryContentKind[];
	regions: HistorySearchRegion[];
	moreMatchesInItem: boolean;
	internal: boolean;
	source?: HistorySource;
}

interface LooseMessage {
	role?: string;
	content?: unknown;
	command?: string;
	output?: string;
	toolName?: string;
	toolCallId?: string;
}

interface LooseEntry {
	id: string;
	type: string;
	timestamp?: string;
	message?: unknown;
	summary?: string;
	customType?: string;
	content?: unknown;
}

interface ToolCallMeta {
	name: string;
	assistantItemId: string;
}

interface IndexedItem {
	itemId: string;
	windowId: string;
	role: string;
	entry: LooseEntry;
	segments: SegmentMetadata[];
	source?: HistorySource;
}

interface SegmentMetadata {
	sourceIndex: number;
	kind: HistoryContentKind;
	toolName?: string;
	toolCallId?: string;
	internal: boolean;
}

interface CanonicalSegment extends SegmentMetadata {
	start: number;
	end: number;
}

interface CanonicalEntry {
	text: string;
	segments: CanonicalSegment[];
}

interface SelectedInterval {
	start: number;
	end: number;
	segments: CanonicalSegment[];
}

interface ProjectionOptions {
	scope?: HistoryScope;
	kind?: HistoryKind;
	toolName?: string;
	excludedToolCallId?: string;
}

interface ListOptions extends ProjectionOptions {
	windowId?: string;
	role?: string;
	limit?: number;
	recentFirst?: boolean;
	afterItemId?: string;
	previewChars: number;
}

interface SearchOptions extends ProjectionOptions {
	windowId?: string;
	role?: string;
	limit?: number;
	recentFirst?: boolean;
	afterItemId?: string;
	excerptChars: number;
}

const INTERNAL_TOOL_NAMES = new Set([
	"history",
	"history_list_windows",
	"history_list_items",
	"history_search",
	"history_read_item",
	"notes",
	"new_context",
	"get_context_remaining",
]);

function isInternalTool(name: unknown): boolean {
	return typeof name === "string" && INTERNAL_TOOL_NAMES.has(name);
}

function messageOf(entry: LooseEntry): LooseMessage | undefined {
	return entry.message && typeof entry.message === "object" ? (entry.message as LooseMessage) : undefined;
}

function toolCallIdOf(block: Record<string, unknown>): string | undefined {
	return typeof block.id === "string" ? block.id : undefined;
}

function toolNameOf(block: Record<string, unknown>): string {
	return typeof block.name === "string" ? block.name : "unknown";
}

function renderToolCall(block: Record<string, unknown>): string {
	let args = "";
	try {
		args = JSON.stringify(block.arguments ?? block.input ?? {});
	} catch {
		args = "(unserializable args)";
	}
	return `[tool_call ${toolNameOf(block)}] ${args}`;
}

function entryRole(entry: LooseEntry): string | null {
	switch (entry.type) {
		case "message": {
			const role = messageOf(entry)?.role;
			return role === "assistant" || role === "user" || role === "toolResult" || role === "custom" || role === "bashExecution"
				? role
				: null;
		}
		case "custom_message":
			return "custom";
		case "compaction":
			return "compaction";
		case "branch_summary":
			return "branchSummary";
		default:
			return null;
	}
}

function windowIdFromBootstrap(summary: string | undefined): string | null {
	if (typeof summary !== "string" || !summary.includes(BOOTSTRAP_MARKER)) return null;
	const match = summary.match(/^Current context window id: (\S+)$/m);
	return match ? match[1] : null;
}

function isPluginBootstrap(entry: LooseEntry): boolean {
	return entry.type === "compaction" && typeof entry.summary === "string" && entry.summary.includes(BOOTSTRAP_MARKER);
}

function canonicalKind(role: string, blockType?: unknown): HistoryContentKind | null {
	if (blockType === "thinking" || blockType === "toolResult") return null;
	if (role === "toolResult" || role === "bashExecution") return "tool_result";
	if (role === "custom") return "other";
	if (blockType === "toolCall") return "tool_call";
	return "message";
}

function messageContent(message: LooseMessage | undefined, role: string): unknown {
	return role === "bashExecution" ? message?.output : message?.content;
}

function metadataForContent(content: unknown, role: string, source: HistorySource | undefined): SegmentMetadata[] {
	if (typeof content === "string") {
		const kind = canonicalKind(role);
		if (!kind || content.trim().length === 0) return [];
		return [{
			sourceIndex: 0,
			kind,
			...(kind === "tool_result" ? { toolName: source?.toolName ?? "unknown", toolCallId: source?.toolCallId } : {}),
			internal: kind === "tool_result" && isInternalTool(source?.toolName),
		}];
	}
	if (!Array.isArray(content)) return [];
	const segments: SegmentMetadata[] = [];
	for (let sourceIndex = 0; sourceIndex < content.length; sourceIndex++) {
		const value = content[sourceIndex];
		if (!value || typeof value !== "object") continue;
		const block = value as Record<string, unknown>;
		const kind = canonicalKind(role, block.type);
		if (!kind || (block.type === "text" && (typeof block.text !== "string" || block.text.trim().length === 0))) continue;
		const toolName = kind === "tool_call" ? toolNameOf(block) : kind === "tool_result" ? source?.toolName ?? "unknown" : undefined;
		const toolCallId = kind === "tool_call" ? toolCallIdOf(block) : kind === "tool_result" ? source?.toolCallId : undefined;
		segments.push({
			sourceIndex,
			kind,
			...(toolName ? { toolName } : {}),
			...(toolCallId ? { toolCallId } : {}),
			internal: (kind === "tool_call" || kind === "tool_result") && isInternalTool(toolName),
		});
	}
	return segments;
}

function pushContribution(
	parts: string[],
	segments: CanonicalSegment[],
	text: string,
	meta: Omit<CanonicalSegment, "start" | "end">,
): void {
	if (text.length === 0) return;
	const separator = parts.length === 0 ? "" : "\n";
	const start = (segments.at(-1)?.end ?? 0) + separator.length;
	parts.push(text);
	segments.push({ ...meta, start, end: start + text.length });
}

function renderCanonicalContent(
	content: unknown,
	role: string,
	source: HistorySource | undefined,
): CanonicalEntry {
	const parts: string[] = [];
	const segments: CanonicalSegment[] = [];
	if (typeof content === "string") {
		const kind = canonicalKind(role);
		if (kind && content.trim().length > 0) {
			pushContribution(parts, segments, content, {
				sourceIndex: 0,
				kind,
				...(kind === "tool_result" ? { toolName: source?.toolName ?? "unknown", toolCallId: source?.toolCallId } : {}),
				internal: kind === "tool_result" && isInternalTool(source?.toolName),
			});
		}
		return { text: parts.join("\n"), segments };
	}
	if (!Array.isArray(content)) return { text: "", segments: [] };
	for (let sourceIndex = 0; sourceIndex < content.length; sourceIndex++) {
		const value = content[sourceIndex];
		if (!value || typeof value !== "object") continue;
		const block = value as Record<string, unknown>;
		const kind = canonicalKind(role, block.type);
		if (!kind) continue;
		let text = "";
		if (block.type === "text") {
			if (typeof block.text !== "string" || block.text.trim().length === 0) continue;
			text = block.text;
		} else if (block.type === "toolCall") {
			text = renderToolCall(block);
		} else if (block.type === "image" || block.type === "imageContent") {
			text = "[image omitted]";
		} else {
			text = `[${String(block.type)} block omitted]`;
		}
		const toolName = kind === "tool_call" ? toolNameOf(block) : kind === "tool_result" ? source?.toolName ?? "unknown" : undefined;
		const toolCallId = kind === "tool_call" ? toolCallIdOf(block) : kind === "tool_result" ? source?.toolCallId : undefined;
		pushContribution(parts, segments, text, {
			sourceIndex,
			kind,
			...(toolName ? { toolName } : {}),
			...(toolCallId ? { toolCallId } : {}),
			internal: (kind === "tool_call" || kind === "tool_result") && isInternalTool(toolName),
		});
	}
	return { text: parts.join("\n"), segments };
}

function selectedSegment(segment: SegmentMetadata, item: IndexedItem, opts: ProjectionOptions): boolean {
	const scope = opts.scope ?? "task";
	const kind = opts.kind ?? "all";
	if (opts.excludedToolCallId && segment.toolCallId === opts.excludedToolCallId) return false;
	if (scope === "task" && segment.internal) return false;
	if (kind !== "all" && segment.kind !== kind) return false;
	if (opts.toolName !== undefined) {
		if (segment.kind !== "tool_call" && segment.kind !== "tool_result") return false;
		if ((segment.toolName ?? "unknown") !== opts.toolName) return false;
	}
	if (kind === "message" && item.role !== "user" && item.role !== "assistant") return false;
	return true;
}

function selectIntervals(rendered: CanonicalEntry, item: IndexedItem, opts: ProjectionOptions): SelectedInterval[] {
	const selected = rendered.segments.filter((segment) => selectedSegment(segment, item, opts));
	const intervals: SelectedInterval[] = [];
	for (const segment of selected) {
		const previous = intervals.at(-1);
		const previousSegment = previous?.segments.at(-1);
		if (
			previous &&
			previousSegment &&
			segment.sourceIndex === previousSegment.sourceIndex + 1 &&
			segment.start === previous.end + 1
		) {
			previous.end = segment.end;
			previous.segments.push(segment);
		} else {
			intervals.push({ start: segment.start, end: segment.end, segments: [segment] });
		}
	}
	return intervals;
}

function applyAfter<T extends { itemId: string }>(items: T[], afterItemId: string | undefined): T[] {
	if (afterItemId === undefined) return items;
	const index = items.findIndex((item) => item.itemId === afterItemId);
	if (index < 0) throw new Error(`cursor position item "${afterItemId}" is no longer in the filtered snapshot`);
	return items.slice(index + 1);
}

function kindsOf(intervals: SelectedInterval[]): HistoryContentKind[] {
	return [...new Set(intervals.flatMap((interval) => interval.segments.map((segment) => segment.kind)))];
}

function projectedText(rendered: CanonicalEntry, intervals: SelectedInterval[]): string {
	return intervals.map((interval) => rendered.text.slice(interval.start, interval.end)).join("\n");
}

function findOccurrences(rendered: CanonicalEntry, intervals: SelectedInterval[], query: string): { matches: HistoryMatch[]; hasMore: boolean } {
	const matches: HistoryMatch[] = [];
	let hasMore = false;
	for (const interval of intervals) {
		const text = rendered.text.slice(interval.start, interval.end);
		let from = 0;
		for (;;) {
			const index = text.indexOf(query, from);
			if (index < 0) break;
			const match = { start: interval.start + index, end: interval.start + index + query.length };
			if (matches.length < 3) matches.push(match);
			else {
				hasMore = true;
				return { matches, hasMore };
			}
			from = index + Math.max(1, query.length);
		}
	}
	return { matches, hasMore };
}

function intervalForMatch(intervals: SelectedInterval[], match: HistoryMatch): SelectedInterval {
	const interval = intervals.find((candidate) => match.start >= candidate.start && match.end <= candidate.end);
	if (!interval) throw new Error("internal history match interval mismatch");
	return interval;
}

function buildRegions(
	rendered: CanonicalEntry,
	intervals: SelectedInterval[],
	matches: HistoryMatch[],
	excerptChars: number,
): HistorySearchRegion[] {
	if (matches.length === 0) return [];
	const perMatch = Math.max(1, Math.floor(excerptChars / matches.length));
	const provisional = matches.map((match) => {
		const interval = intervalForMatch(intervals, match);
		const visibleMatchLength = Math.min(match.end - match.start, perMatch);
		const before = Math.max(0, Math.floor((perMatch - visibleMatchLength) / 2));
		let start = Math.max(interval.start, match.start - before);
		let end = Math.min(interval.end, start + perMatch);
		start = Math.max(interval.start, end - perMatch);
		return { start, end, interval, matches: [match] };
	});
	const merged: typeof provisional = [];
	for (const region of provisional) {
		const previous = merged.at(-1);
		if (previous && previous.interval === region.interval && region.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, region.end);
			previous.matches.push(...region.matches);
		} else {
			merged.push(region);
		}
	}
	return merged.map((region) => ({
		matches: region.matches,
		excerptStart: region.start,
		excerptEnd: region.end,
		readOffset: region.start,
		readLimit: region.end - region.start,
		text: rendered.text.slice(region.start, region.end),
		prefixOmitted: region.start > region.interval.start,
		suffixOmitted: region.end < region.interval.end,
	}));
}

export class HistoryStore {
	private readonly windows: Array<Pick<HistoryWindow, "windowId" | "openedByCompaction">> = [];
	private readonly items: IndexedItem[] = [];
	private readonly rendered = new Map<string, CanonicalEntry>();
	private renderedCount = 0;

	constructor(branch: LooseEntry[]) {
		const priorToolCalls = new Map<string, ToolCallMeta>();
		let windowId = "w1";
		let openedByCompaction = false;
		const pushWindow = (): void => {
			this.windows.push({ windowId, openedByCompaction });
		};
		for (const entry of branch) {
			if (entry.type === "compaction") {
				pushWindow();
				windowId = windowIdFromBootstrap(entry.summary) ?? `w${this.windows.length + 1}`;
				openedByCompaction = true;
			}
			const role = entryRole(entry);
			if (role) {
				let source: HistorySource | undefined;
				const msg = messageOf(entry);
				if (entry.type === "message" && role === "bashExecution") {
					source = { toolName: "bash" };
				} else if (entry.type === "message" && role === "toolResult") {
					const toolCallId = msg?.toolCallId;
					const linked = toolCallId ? priorToolCalls.get(toolCallId) : undefined;
					const toolName = msg?.toolName ?? linked?.name;
					source = {
						...(toolName ? { toolName } : {}),
						...(toolCallId ? { toolCallId } : {}),
						...(linked ? { assistantItemId: linked.assistantItemId } : {}),
					};
				}
				let segments: SegmentMetadata[];
				if (entry.type === "compaction" || entry.type === "branch_summary") {
					segments = (entry.summary ?? "").length > 0
						? [{ sourceIndex: 0, kind: "other", internal: isPluginBootstrap(entry) }]
						: [];
				} else if (entry.type === "custom_message") {
					segments = metadataForContent(entry.content, "custom", undefined);
					if (entry.customType?.startsWith(CUSTOM_TYPE_PREFIX)) {
						segments = segments.map((segment) => ({ ...segment, internal: true }));
					}
				} else {
					segments = metadataForContent(messageContent(msg, role), role, source);
					if ((role === "toolResult" || role === "bashExecution") && segments.length === 0) {
						segments = [{
							sourceIndex: 0,
							kind: "tool_result",
							toolName: source?.toolName ?? "unknown",
							toolCallId: source?.toolCallId,
							internal: isInternalTool(source?.toolName),
						}];
					}
				}
				if (segments.length > 0) this.items.push({ itemId: entry.id, windowId, role, entry, segments, source });
			}
			const msg = messageOf(entry);
			if (entry.type === "message" && msg?.role === "assistant" && Array.isArray(msg.content)) {
				for (const value of msg.content as unknown[]) {
					if (!value || typeof value !== "object") continue;
					const block = value as Record<string, unknown>;
					if (block.type !== "toolCall") continue;
					const callId = toolCallIdOf(block);
					if (!callId) continue;
					priorToolCalls.set(callId, { name: toolNameOf(block), assistantItemId: entry.id });
				}
			}
		}
		pushWindow();
	}

	private render(item: IndexedItem): CanonicalEntry {
		const cached = this.rendered.get(item.itemId);
		if (cached) return cached;
		const entry = item.entry;
		let rendered: CanonicalEntry;
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			const text = entry.summary ?? "";
			rendered = {
				text,
				segments: text.length === 0 ? [] : [{ start: 0, end: text.length, sourceIndex: 0, kind: "other", internal: isPluginBootstrap(entry) }],
			};
		} else if (entry.type === "custom_message") {
			rendered = renderCanonicalContent(entry.content, "custom", undefined);
			if (entry.customType?.startsWith(CUSTOM_TYPE_PREFIX)) {
				rendered.segments = rendered.segments.map((segment) => ({ ...segment, internal: true }));
			}
		} else {
			const msg = messageOf(entry);
			rendered = renderCanonicalContent(messageContent(msg, item.role), item.role, item.source);
			if ((item.role === "toolResult" || item.role === "bashExecution") && rendered.text.length === 0) {
				const text = "[empty tool result]";
				rendered = {
					text,
					segments: [{
						start: 0,
						end: text.length,
						sourceIndex: 0,
						kind: "tool_result",
						toolName: item.source?.toolName ?? "unknown",
						toolCallId: item.source?.toolCallId,
						internal: isInternalTool(item.source?.toolName),
					}],
				};
			}
		}
		this.rendered.set(item.itemId, rendered);
		this.renderedCount++;
		return rendered;
	}

	private projected(item: IndexedItem, opts: ProjectionOptions): { rendered: CanonicalEntry; intervals: SelectedInterval[] } {
		const rendered = this.render(item);
		return { rendered, intervals: selectIntervals(rendered, item, opts) };
	}

	private candidates(opts: ProjectionOptions & { windowId?: string; role?: string; recentFirst?: boolean }): IndexedItem[] {
		let selected = this.items;
		if (opts.windowId) selected = selected.filter((item) => item.windowId === opts.windowId);
		if (opts.role) selected = selected.filter((item) => item.role === opts.role);
		selected = selected.filter((item) => item.segments.some((segment) => selectedSegment(segment, item, opts)));
		return opts.recentFirst ? [...selected].reverse() : selected;
	}

	renderedTextCount(): number {
		return this.renderedCount;
	}

	listWindows(excludedToolCallId?: string): HistoryWindow[] {
		const counts = new Map<string, { taskItems: number; allItems: number }>();
		for (const window of this.windows) counts.set(window.windowId, { taskItems: 0, allItems: 0 });
		for (const item of this.items) {
			const count = counts.get(item.windowId)!;
			if (item.segments.some((segment) => selectedSegment(segment, item, { scope: "all", kind: "all", excludedToolCallId }))) count.allItems++;
			if (item.segments.some((segment) => selectedSegment(segment, item, { scope: "task", kind: "all", excludedToolCallId }))) count.taskItems++;
		}
		return this.windows
			.map((window) => ({ ...window, ...(counts.get(window.windowId) ?? { taskItems: 0, allItems: 0 }) }))
			.filter((window) => window.allItems > 0 || window.openedByCompaction);
	}

	listItems(opts: ListOptions): HistoryListItem[] {
		const projection: ProjectionOptions = {
			scope: opts.scope ?? "task",
			kind: opts.kind ?? "message",
			toolName: opts.toolName,
			excludedToolCallId: opts.excludedToolCallId,
		};
		const ordered = applyAfter(this.candidates({ ...projection, windowId: opts.windowId, role: opts.role, recentFirst: opts.recentFirst !== false }), opts.afterItemId);
		const limit = opts.limit ? Math.max(1, opts.limit) : ordered.length;
		return ordered.slice(0, limit).map((item) => {
			const { rendered, intervals } = this.projected(item, projection);
			const projected = projectedText(rendered, intervals);
			return {
				itemId: item.itemId,
				windowId: item.windowId,
				role: item.role,
				preview: truncate(projected, opts.previewChars),
				totalChars: rendered.text.length,
				projectedChars: projected.length,
				kinds: kindsOf(intervals),
				internal: intervals.some((interval) => interval.segments.some((segment) => segment.internal)),
				...(item.source ? { source: item.source } : {}),
			};
		});
	}

	readItem(itemId: string, offsetChars: number, limitChars: number): HistoryItem & { totalChars: number } {
		const item = this.items.find((candidate) => candidate.itemId === itemId);
		if (!item) throw new Error(`no history item with id "${itemId}"`);
		const offset = Math.max(0, offsetChars);
		const rendered = this.render(item);
		return {
			itemId: item.itemId,
			windowId: item.windowId,
			role: item.role,
			text: rendered.text.slice(offset, offset + Math.max(1, limitChars)),
			totalChars: rendered.text.length,
			...(item.source ? { source: item.source } : {}),
		};
	}

	searchContents(query: string, opts: SearchOptions): HistorySearchItem[] {
		if (typeof query !== "string" || query.trim().length === 0) throw new Error("query is required and cannot be blank");
		const projection: ProjectionOptions = {
			scope: opts.scope ?? "task",
			kind: opts.kind ?? "all",
			toolName: opts.toolName,
			excludedToolCallId: opts.excludedToolCallId,
		};
		const ordered = applyAfter(this.candidates({ ...projection, windowId: opts.windowId, role: opts.role, recentFirst: opts.recentFirst !== false }), opts.afterItemId);
		const limit = opts.limit ? Math.max(1, opts.limit) : ordered.length;
		const out: HistorySearchItem[] = [];
		for (const item of ordered) {
			if (out.length >= limit) break;
			const { rendered, intervals } = this.projected(item, projection);
			const found = findOccurrences(rendered, intervals, query);
			if (found.matches.length === 0) continue;
			out.push({
				itemId: item.itemId,
				windowId: item.windowId,
				role: item.role,
				totalChars: rendered.text.length,
				kinds: kindsOf(intervals),
				regions: buildRegions(rendered, intervals, found.matches, opts.excerptChars),
				moreMatchesInItem: found.hasMore,
				internal: intervals.some((interval) => interval.segments.some((segment) => segment.internal)),
				...(item.source ? { source: item.source } : {}),
			});
		}
		return out;
	}
}

export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(1, maxChars))}…[truncated, ${text.length} chars total]`;
}
