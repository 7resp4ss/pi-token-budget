import { newContextConfirmation } from "../prompts.ts";
import { defineTool, textResult, type ToolDeps, type ToolRegistrar } from "./deps.ts";

export function registerNewContextTool(pi: ToolRegistrar, deps: ToolDeps): void {
	defineTool(pi, "new_context", async (_params, ctx) => {
		deps.requestRollover();
		if (ctx.isIdle()) deps.triggerCompaction(ctx);
		// Pi stops early only when every finalized result in this batch terminates.
		// Mixed batches and queued steering/follow-ups can still delay the boundary.
		return { ...textResult(newContextConfirmation(), deps.config), terminate: true };
	});
}
