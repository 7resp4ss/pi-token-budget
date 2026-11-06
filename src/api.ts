/** Public, launcher-independent task registration API. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskContext } from "./task-registry.ts";
export { createTokenBudgetExtension, type TokenBudgetOptions } from "./index.ts";
export { TaskRegistry, resolveAgentName, type TaskContext, type AgentRegistration } from "./task-registry.ts";
export type { SubagentsOptions } from "./subagents-adapter.ts";

export interface TaskSnapshot { context: TaskContext; agentName: string }
/** Query after session_start. Use snapshot.agentName as parentAgentName when
 * creating a hierarchical child; omit agentName for an automatic stable name. */
export function getTokenBudgetTask(pi: Pick<ExtensionAPI, "events">): TaskSnapshot | undefined {
	let snapshot: TaskSnapshot | undefined;
	pi.events.emit("pi-token-budget:task:v1", { respond: (value: TaskSnapshot) => { snapshot = value; } });
	return snapshot;
}
