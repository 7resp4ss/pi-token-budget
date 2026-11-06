/** Optional adapter using pi-subagents' public required-child-extensions API.
 * All generated code/state is owned by this package; no upstream edits. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { atomicWrite } from "./storage.ts";
import type { TaskRegistry } from "./task-registry.ts";

export interface SubagentsOptions { modulePath?: string; enabled?: boolean }
export interface RequiredExtensionsAPI {
	registerRequiredChildExtensions(input: { sessionId: string; extensions: Array<{ id: string; path: string }>; requireForAllRunners?: boolean }): { dispose(): void };
}

function publicEntry(root: string): string | undefined {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		if (pkg.name !== "pi-subagents") return undefined;
		const entry = pkg.exports?.["./required-child-extensions"];
		const relative = typeof entry === "string" ? entry : entry?.import ?? entry?.default;
		return typeof relative === "string" ? path.resolve(root, relative) : undefined;
	} catch { return undefined; }
}

export function discoverSubagentsAPI(pi: ExtensionAPI, configured?: string): string | undefined {
	if (configured) {
		const resolved = path.resolve(configured);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return publicEntry(resolved);
		return resolved;
	}
	for (const tool of pi.getAllTools?.() ?? []) {
		const source = tool.sourceInfo?.path;
		if (!source) continue;
		let dir = path.dirname(fs.existsSync(source) ? fs.realpathSync(source) : source);
		for (let depth = 0; depth < 10; depth++) {
			const found = publicEntry(dir);
			if (found) return found;
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return undefined;
}

export function writeChildExtension(task: TaskRegistry): string {
	const file = path.join(task.context.taskDir, "child-extension.ts");
	const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
	// One root-owned entry is inherited by all descendants, including detached
	// processes. Per-session addresses are derived at session_start, never env.
	const taskContext = { ...task.context, parentAgentName: "/root" };
	const source = `import { createTokenBudgetExtension } from ${JSON.stringify(entry)};\nexport default createTokenBudgetExtension({ task: ${JSON.stringify(taskContext)} });\n`;
	if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== source) atomicWrite(file, source);
	return file;
}

export async function attachSubagents(pi: ExtensionAPI, task: TaskRegistry, options: SubagentsOptions = {}): Promise<{ dispose(): void } | undefined> {
	if (options.enabled === false) return undefined;
	const configured = options.modulePath ?? process.env.PI_TOKEN_BUDGET_SUBAGENTS_MODULE;
	const entry = discoverSubagentsAPI(pi, configured);
	if (!entry) {
		if (configured) throw new Error("Configured pi-subagents public required-child-extensions entry was not found");
		return undefined;
	}
	const api = await import(pathToFileURL(entry).href) as RequiredExtensionsAPI;
	if (typeof api.registerRequiredChildExtensions !== "function") throw new Error("pi-subagents lacks the public registerRequiredChildExtensions API");
	// The API refuses competing registrations. Never dispose or replace another
	// component's registration; report the conflict to the host instead.
	return api.registerRequiredChildExtensions({
		// pi-subagents launch/preflight look up the parent's Pi runtime UUID.
		// sessionKey may be a file path and is only our durable storage identity.
		sessionId: task.agent.sessionId,
		extensions: [{ id: "pi-token-budget", path: writeChildExtension(task) }],
	});
}
