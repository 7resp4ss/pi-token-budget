/**
 * Tool: new_context
 * ==================
 * The model's escape hatch: declare that the current window is no longer
 * useful and start a fresh one. Takes NO parameters — it is a pure intent
 * declaration, nothing is configurable (no summary, no retention options;
 * environment state is carried by pi itself, information continuity is the
 * model's job via notes).
 *
 * Execution semantics (matches codex's deferred-consumption design):
 * 1. execute() only sets the pending-rollover flag and returns immediately —
 *    the in-flight response is NEVER interrupted;
 * 2. the actual rollover runs at the turn boundary (agent_settled →
 *    ctx.compact() → session_before_compact interception) or when pi's own
 *    auto-compaction fires, whichever comes first;
 * 3. after the rollover commits, the orchestration layer injects a
 *    continuation message so the task continues autonomously in the new
 *    window.
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NEW_CONTEXT_CONFIRMATION, TOOL_PRIVATE_USAGE_HINT } from "../prompts.ts";
import { textResult, type ToolDeps, type ToolRegistrar } from "./deps.ts";

export function registerNewContextTool(pi: ToolRegistrar, deps: ToolDeps): void {
	pi.registerTool({
		name: "new_context",
		label: "New Context Window",
		description:
			"Start a new context window after this turn completes. Does not clear, reset, or otherwise affect environment, filesystem, or tool state. The current conversation is NOT summarized or carried over: save anything important to notes first. " +
			TOOL_PRIVATE_USAGE_HINT,
		promptSnippet: "Start a fresh context window (new_context); save notes first.",
		parameters: Type.Object({}),
		async execute(
			_toolCallId: string,
			_params: Record<string, never>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			// requestRollover is intentionally idempotent: the orchestration layer's
			// pendingNewContext/compactionInFlight booleans collapse repeats.
			deps.requestRollover();
			// Rollover runs at the turn boundary (agent_settled) or when pi's
			// auto-compaction fires; never mid-response.
			if (ctx.isIdle()) deps.triggerCompaction(ctx);
			return textResult(NEW_CONTEXT_CONFIRMATION, deps.config);
		},
	});
}
