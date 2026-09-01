/**
 * History store: a read-only, window-segmented index over the session tree.
 *
 * Old windows are never deleted from the session file; compaction entries
 * act as window boundaries. This store renders entries as bounded text items
 * addressable by opaque item ids (session entry ids) so the model can
 * recover details on demand after a rollover.
 *
 * All outputs are truncated by the caller-provided cap; nothing here can
 * return unbounded content.
 */

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

function renderEntry(entry: LooseEntry): { role: string; text: string } | null {
	switch (entry.type) {
		case "message": {
			const msg = entry.message as { role?: string; content?: unknown } | undefined;
			if (!msg) return null;
			const role = msg.role ?? "unknown";
			if (role === "toolResult") {
				const text = contentBlocksToText(msg.content);
				return { role, text: text || "[empty tool result]" };
			}
			if (role === "assistant") {
				const text = contentBlocksToText(msg.content);
				return text.trim() ? { role, text } : null;
			}
			if (role === "user" || role === "custom" || role === "bashExecution") {
				const text = contentBlocksToText(msg.content);
				return text.trim() ? { role, text } : null;
			}
			return null; // compactionSummary / branchSummary message roles appear as entries below
		}
		case "custom_message": {
			const text = contentBlocksToText(entry.content);
			return text.trim() ? { role: "custom", text } : null;
		}
		case "compaction":
			return { role: "compaction", text: entry.summary ?? "" };
		case "branch_summary":
			return { role: "branchSummary", text: entry.summary ?? "" };
		default:
			return null; // "custom" entries are plugin/extension state, not conversation
	}
}

export class HistoryStore {
	private readonly windows: HistoryWindow[] = [];
	private readonly items: HistoryItem[] = [];

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
				windowId = `w${windows.length + 1}`;
				openedByCompaction = true;
				count = 0;
			}
			const rendered = renderEntry(entry);
			if (!rendered) continue;
			this.items.push({ itemId: entry.id, windowId, role: rendered.role, text: rendered.text });
			count++;
		}
		pushWindow();
		this.windows = windows;
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
		return ordered.slice(0, limit).map((i) => ({
			itemId: i.itemId,
			windowId: i.windowId,
			role: i.role,
			preview: truncate(i.text, opts.previewChars),
			chars: i.text.length,
		}));
	}

	readItem(itemId: string, offsetChars: number, limitChars: number): HistoryItem & { totalChars: number } {
		const item = this.items.find((i) => i.itemId === itemId);
		if (!item) throw new Error(`no history item with id "${itemId}"`);
		const offset = Math.max(0, offsetChars);
		const totalChars = item.text.length;
		const slice = item.text.slice(offset, offset + Math.max(1, limitChars));
		return { ...item, text: slice, totalChars };
	}

	searchContents(query: string, opts: { windowId?: string; role?: string; limit?: number; recentFirst?: boolean; previewChars: number }): Array<{ itemId: string; windowId: string; role: string; preview: string }> {
		if (typeof query !== "string" || query.length === 0) throw new Error("query is required");
		let selected = this.items;
		if (opts.windowId) selected = selected.filter((i) => i.windowId === opts.windowId);
		if (opts.role) selected = selected.filter((i) => i.role === opts.role);
		const matched = selected.filter((i) => i.text.includes(query));
		const ordered = opts.recentFirst ? [...matched].reverse() : matched;
		const limit = opts.limit ? Math.max(1, opts.limit) : ordered.length;
		return ordered.slice(0, limit).map((i) => ({
			itemId: i.itemId,
			windowId: i.windowId,
			role: i.role,
			preview: previewAround(i.text, query, opts.previewChars),
		}));
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
