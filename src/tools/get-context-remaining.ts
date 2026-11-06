import { defineTool, notesBloatWarnings, textResult, type ToolDeps, type ToolRegistrar } from "./deps.ts";

export function registerGetContextRemainingTool(pi: ToolRegistrar, deps: ToolDeps): void {
	defineTool(pi, "get_context_remaining", async (_params, ctx) => {
		const state = deps.getState();
		const task = deps.getTask();
		const remaining = deps.remainingTokens(ctx);
		const hard = deps.hardTriggerRemaining(ctx);
		return textResult([
			`You have ${remaining ?? "unknown"} tokens left in this context window. (window ${state.currentWindowId})`,
			`Agent name: ${task.agent.agentName}; root task: ${task.context.runId}`,
			`Tokens until configured hard trigger: ${hard ?? "unknown or disabled"}. The full-window remaining value above does not subtract this trigger.`,
			`Registered task agents: ${task.listAgents().map(a => a.agentName).join(", ")}`,
			...notesBloatWarnings(() => deps.getNotes(), deps.config),
		].join("\n"), deps.config);
	});
}
