import { CUSTOM_TYPE_CONTEXT_WINDOW, CUSTOM_TYPE_PREFIX } from "./prompts.ts";
import type { LooseEntry } from "./stores/history-store.ts";

interface Message { role?: string; content?: unknown; customType?: string; timestamp?: unknown; [key: string]: unknown }
const key = (m: Message): string => JSON.stringify([m.role, m.content, m.timestamp, m.toolCallId, m.customType]);

/** Add real persisted IDs to model-context copies only. Ordered queues handle
 * repeated identical messages. Persisted messages, image data and tool IDs stay intact. */
export function projectItemIds<T>(messages: T[], branch: LooseEntry[], identity: string): T[] {
	const ids = new Map<string, string[]>();
	for (const entry of branch) {
		let message: Message | undefined;
		if (entry.type === "message") message = entry.message as Message;
		else if (entry.type === "custom_message") message = { role: "custom", content: entry.content, timestamp: typeof entry.timestamp === "string" ? new Date(entry.timestamp).getTime() : undefined, customType: entry.customType };
		if (!message || message.role === "assistant" || entry.customType?.startsWith(CUSTOM_TYPE_PREFIX)) continue;
		const k = key(message);
		ids.set(k, [...(ids.get(k) ?? []), entry.id]);
	}
	return messages.map(value => {
		const msg = value as Message;
		// A dynamic identity is refreshed on every sampling boundary, including
		// automatic mid-loop compaction. It never enters the static system prompt.
		if (msg.role === "custom" && msg.customType === CUSTOM_TYPE_CONTEXT_WINDOW) return { ...msg, content: identity } as T;
		const id = ids.get(key(msg))?.shift();
		if (!id) return value;
		const marker = `[id: ${id}]`;
		const content = typeof msg.content === "string" ? `${msg.content}\n${marker}`
			: Array.isArray(msg.content) ? [...msg.content, { type: "text", text: marker }] : msg.content;
		return { ...msg, content } as T;
	});
}
