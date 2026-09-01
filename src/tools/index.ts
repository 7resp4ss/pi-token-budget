/**
 * Tool registration entry point. Registers all four model-facing tools:
 * get_context_remaining, new_context, notes, history.
 *
 * See each sibling file for its tool's documentation, and README.md in this
 * directory for the overall tool surface.
 */

import type { ToolDeps, ToolRegistrar } from "./deps.ts";
import { registerGetContextRemainingTool } from "./get-context-remaining.ts";
import { registerHistoryTool } from "./history.ts";
import { registerNewContextTool } from "./new-context.ts";
import { registerNotesTool } from "./notes.ts";

export type { ToolDeps, ToolRegistrar } from "./deps.ts";

export function registerWindowTools(pi: unknown, deps: ToolDeps): void {
	const registrar = pi as ToolRegistrar;
	registerGetContextRemainingTool(registrar, deps);
	registerNewContextTool(registrar, deps);
	registerNotesTool(registrar, deps);
	registerHistoryTool(registrar, deps);
}
