/**
 * Tool: get_context_remaining
 * ============================
 * The budget "dashboard" (pull channel). The model queries this whenever it
 * wants to plan around the remaining token budget; no state changes.
 *
 * Data source: pi's live context usage (last assistant message's
 * server-reported usage + trailing estimates). Returns "unknown" right after
 * a rollover until the next response reports usage — mirroring codex.
 *
 * Output shape (one bounded sentence, plus optional notes-bloat hints):
 *   "You have 4231 tokens left in this context window. (window 2, id w-abc123)"
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TOOL_PRIVATE_USAGE_HINT } from "../prompts.ts";
import { notesBloatWarnings, textResult, type ToolDeps, type ToolRegistrar } from "./deps.ts";

export function registerGetContextRemainingTool(pi: ToolRegistrar, deps: ToolDeps): void {
	pi.registerTool({
		name: "get_context_remaining",
		label: "Context Remaining",
		description:
			"Get the remaining tokens in the current context window, plus the current window id and number. Use this to plan long tasks and decide when to checkpoint notes or start a new context window. " +
			TOOL_PRIVATE_USAGE_HINT,
		promptSnippet: "Check remaining context tokens (get_context_remaining).",
		parameters: Type.Object({}),
		async execute(
			_toolCallId: string,
			_params: Record<string, never>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const state = deps.getState();
			const remaining = deps.remainingTokens(ctx);
			const text =
				remaining === null
					? `You have unknown tokens left in this context window. (window ${state.windowNumber}, id ${state.currentWindowId})`
					: `You have ${remaining} tokens left in this context window. (window ${state.windowNumber}, id ${state.currentWindowId})`;
			const warnings = notesBloatWarnings(() => deps.getNotes(), deps.config);
			return textResult(warnings.length > 0 ? `${text}\n${warnings.join("\n")}` : text, deps.config);
		},
	});
}
