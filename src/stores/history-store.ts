/**
 * History store: a read-only, window-segmented index over the session tree.
 *
 * Old windows are never deleted from the session file; compaction entries
 * act as window boundaries. This store renders entries as bounded text items
 * addressable by opaque item ids (session entry ids) so the model can
 * recover details on demand after a rollover.
 *
 * Lazy rendering: the constructor runs a single allocation-free metadata
 * pass (ids, roles, window segmentation, exact inclusion). Entry text is
 * built only when an operation actually touches it — read_item renders one
 * entry, list_items renders only the returned page, search stops after
 * `limit` matches. No operation allocates the whole session's text, so
 * rebuilding the index per call stays cheap on long multi-window sessions.
 * renderedTextCount() exists so tests can lock this property in.
 *
 * All outputs are truncated by the caller-provided cap; nothing here can
 * return unbounded content.
 */

import { BOOTSTRAP_MARKER } from "../prompts.ts";

export interface HistoryItem {
	itemId: string;
	windowId: string;
	role: string;
	/** Full rendered text (used for read_item ranges and search). */
	text: string;
}

export interface HistoryWindow {
	windowId: string;
	itemCount: number;
	/** Entry id of the compaction that opened this window, when applicable. */
	openedByCompaction: boolean;
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

/** Internal indexed item: entry reference plus metadata; no text is built. */
interface IndexedItem {
	itemId: string;
	windowId: string;
	role: string;
	entry: LooseEntry;
}

function contentBlocksToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (!block || typeof block !== "object") continue;
		const type = block.type;
		if (type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (type === "thinking") continue;
		else if (type === "toolCall") {
			const name = typeof block.name === "string" ? block.name : "unknown";
			let args = "";
			try {
				args = JSON.stringify(block.arguments ?? block.input ?? {});
			} catch {
				args = "(unserializable args)";
			}
			parts.push(`[tool_call ${name}] ${args}`);
		} else if (type === "toolResult" || type === "text") continue; // toolResult handled at message level
		else if (type === "image" || type === "imageContent") parts.push("[image omitted]");
		else parts.push(`[${String(type)} block omitted]`);
	}
	return parts.join("\n");
}

/**
 * Cheap inclusion + role determination for the constructor's metadata pass.
 * Must agree with contentBlocksToText / renderEntryText below: an entry is
 * included exactly when its rendered text is non-empty — except toolResult
 * messages (placeholder keeps them non-empty) and compaction / branch_summary
 * entries (always included, even with an empty summary). Locked by the smoke
 * equivalence tests.
 */
function entryMeta(entry: LooseEntry): { role: string } | null {
	switch (entry.type) {
		case "message": {
			const msg = entry.message as { role?: string; content?: unknown } | undefined;
			if (!msg) return null;
			const role = msg.role ?? "unknown";
			if (role === "toolResult") return { role };
			if (role === "assistant" || role === "user" || role === "custom" || role === "bashExecution") {
				return contentRendersNonEmpty(msg.content) ? { role } : null;
			}
			return null; // compactionSummary / branchSummary message roles appear as entries below
		}
		case "custom_message":
			return contentRendersNonEmpty(entry.content) ? { role: "custom" } : null;
		case "compaction":
			return { role: "compaction" };
		case "branch_summary":
			return { role: "branchSummary" };
		default:
			return null; // "custom" entries are plugin/extension state, not conversation
	}
}

/**
 * Allocation-free exact emulation of `contentBlocksToText(content).trim() !== ""`.
 * Block contribution rules MUST mirror contentBlocksToText: thinking and
 * toolResult blocks contribute nothing; text blocks contribute their text;
 * toolCall blocks always contribute "[tool_call …]"; image blocks always
 * contribute "[image omitted]"; every other block type contributes
 * "[T block omitted]". Keep the two functions adjacent and co-tested.
 */
function contentRendersNonEmpty(content: unknown): boolean {
	if (typeof content === "string") return content.trim() !== "";
	if (!Array.isArray(content)) return false;
	for (const block of content as Array<Record<string, unknown>>) {
		if (!block || typeof block !== "object") continue;
		const type = block.type;
		if (type === "text") {
			if (typeof block.text === "string" && block.text.trim() !== "") return true;
		} else if (type === "thinking" || type === "toolResult") {
			continue;
		} else {
			// toolCall ("[tool_call …]"), image ("[image omitted]"), and any
			// other block type ("[T block omitted]") always contribute text.
			return true;
		}
	}
	return false;
}

/** Render one entry's full text on demand. Only called for included entries. */
function renderEntryText(entry: LooseEntry): string {
	if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary ?? "";
	if (entry.type === "custom_message") return contentBlocksToText(entry.content);
	if (entry.type === "message") {
		const msg = entry.message as { role?: string; content?: unknown } | undefined;
		const text = contentBlocksToText(msg?.content);
		if ((msg?.role ?? "unknown") === "toolResult") return text || "[empty tool result]";
		return text;
	}
	return "";
}

/**
 * Rollover bootstraps embed the authoritative window id in the compaction
 * summary; read it back so history labels are the exact tokens the model saw
 * in that window's bootstrap. Compactions without our marker (foreign
 * summarization) fall back to ordinal counting.
 */
function windowIdFromBootstrap(summary: string | undefined): string | null {
	if (typeof summary !== "string" || !summary.includes(BOOTSTRAP_MARKER)) return null;
	const match = summary.match(/^Current context window id: (\S+)$/m);
	return match ? match[1] : null;
}

export class HistoryStore {
	private readonly windows: HistoryWindow[] = [];
	private readonly items: IndexedItem[] = [];
	private renderedCount = 0;

	constructor(branch: LooseEntry[]) {
		let windowId = "w1";
		let openedByCompaction = false;
		let count = 0;
		const windows: HistoryWindow[] = [];
		const pushWindow = (): void => {
			windows.push({ windowId, itemCount: count, openedByCompaction });
		};
		for (const entry of branch) {
			if (entry.type === "compaction") {
				pushWindow();
				// The compaction entry itself belongs to the new window it opens.
				windowId = windowIdFromBootstrap(entry.summary) ?? `w${windows.length + 1}`;
				openedByCompaction = true;
				count = 0;
			}
			const meta = entryMeta(entry);
			if (!meta) continue;
			this.items.push({ itemId: entry.id, windowId, role: meta.role, entry });
			count++;
		}
		pushWindow();
		this.windows = windows;
	}

	/**
	 * Render one item's text on demand. Compaction / branch_summary texts are
	 * plain summary-string references (zero allocation) and do not count as
	 * renders.
	 */
	private textOf(item: IndexedItem): string {
		if (item.entry.type === "compaction" || item.entry.type === "branch_summary") {
			return item.entry.summary ?? "";
		}
		this.renderedCount++;
		return renderEntryText(item.entry);
	}

	/** Test-only: how many entry texts this instance has rendered so far. */
	renderedTextCount(): number {
		return this.renderedCount;
	}

	listWindows(): HistoryWindow[] {
		return this.windows.filter((w) => w.itemCount > 0 || w.openedByCompaction);
	}

	listItems(opts: {
		windowId?: string;
		role?: string;
		limit?: number;
		recentFirst?: boolean;
		previewChars: number;
	}): Array<{ itemId: string; windowId: string; role: string; preview: string; chars: number }> {
		let selected = this.items;
		if (opts.windowId) selected = selected.filter((i) => i.windowId === opts.windowId);
		if (opts.role) selected = selected.filter((i) => i.role === opts.role);
		const ordered = opts.recentFirst ? [...selected].reverse() : selected;
		const limit = opts.limit ? Math.max(1, opts.limit) : ordered.length;
		return ordered.slice(0, limit).map((i) => {
			const text = this.textOf(i);
			return {
				itemId: i.itemId,
				windowId: i.windowId,
				role: i.role,
				preview: truncate(text, opts.previewChars),
				chars: text.length,
			};
		});
	}

	readItem(itemId: string, offsetChars: number, limitChars: number): HistoryItem & { totalChars: number } {
		const item = this.items.find((i) => i.itemId === itemId);
		if (!item) throw new Error(`no history item with id "${itemId}"`);
		const offset = Math.max(0, offsetChars);
		const text = this.textOf(item);
		const totalChars = text.length;
		const slice = text.slice(offset, offset + Math.max(1, limitChars));
		return { itemId: item.itemId, windowId: item.windowId, role: item.role, text: slice, totalChars };
	}

	searchContents(query: string, opts: { windowId?: string; role?: string; limit?: number; recentFirst?: boolean; previewChars: number }): Array<{ itemId: string; windowId: string; role: string; preview: string }> {
		if (typeof query !== "string" || query.length === 0) throw new Error("query is required");
		let selected = this.items;
		if (opts.windowId) selected = selected.filter((i) => i.windowId === opts.windowId);
		if (opts.role) selected = selected.filter((i) => i.role === opts.role);
		const ordered = opts.recentFirst ? [...selected].reverse() : selected;
		const limit = opts.limit ? Math.max(1, opts.limit) : ordered.length;
		// Scan in output order and stop once `limit` matches are found; the
		// result set is identical to filter-everything-then-slice, but entries
		// after the limit-th match are never rendered.
		const out: Array<{ itemId: string; windowId: string; role: string; preview: string }> = [];
		for (const i of ordered) {
			if (out.length >= limit) break;
			const text = this.textOf(i);
			if (text.includes(query)) {
				out.push({ itemId: i.itemId, windowId: i.windowId, role: i.role, preview: previewAround(text, query, opts.previewChars) });
			}
		}
		return out;
	}
}

export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(1, maxChars))}…[truncated, ${text.length} chars total]`;
}

function previewAround(text: string, query: string, maxChars: number): string {
	const idx = text.indexOf(query);
	if (idx < 0) return truncate(text, maxChars);
	const half = Math.floor(maxChars / 2);
	const start = Math.max(0, idx - half);
	const slice = text.slice(start, start + maxChars);
	return `${start > 0 ? "…" : ""}${slice}…[${text.length} chars total]`;
}
