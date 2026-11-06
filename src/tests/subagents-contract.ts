/** Public API adapter contract. Set PI_TOKEN_BUDGET_TEST_SUBAGENTS_MODULE to
 * run against installed OI/upstream required-child-extensions and preflight. */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TaskRegistry } from "../task-registry.ts";
import { attachSubagents, discoverSubagentsAPI, type RequiredExtensionsAPI } from "../subagents-adapter.ts";

function publicPreflightEntry(requiredEntry: string): string {
	let dir = path.dirname(requiredEntry);
	for (let depth = 0; depth < 10; depth++) {
		const manifest = path.join(dir, "package.json");
		if (fs.existsSync(manifest)) {
			const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
			if (pkg.name === "pi-subagents") {
				const exported = pkg.exports?.["./preflight"];
				const relative = typeof exported === "string" ? exported : exported?.import ?? exported?.default;
				assert.equal(typeof relative, "string", "pi-subagents must export its public preflight API");
				return path.resolve(dir, relative);
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`Cannot find pi-subagents package for ${requiredEntry}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-budget-subagents-"));
try {
	const fixture = path.join(temp, "fixture-package"); fs.mkdirSync(fixture);
	fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "pi-subagents", exports: { "./required-child-extensions": "./required.mjs", "./preflight": "./preflight.mjs" } }));
	fs.writeFileSync(path.join(fixture, "index.ts"), "export default () => {};\n");
	fs.writeFileSync(path.join(fixture, "state.mjs"), "export const sessions = new Map();\n");
	fs.writeFileSync(path.join(fixture, "required.mjs"), `import { sessions } from './state.mjs';\nexport function registerRequiredChildExtensions(input) { if(sessions.has(input.sessionId)) throw new Error('already registered'); sessions.set(input.sessionId,input); return { dispose(){ if(sessions.get(input.sessionId) === input) sessions.delete(input.sessionId); } }; }\n`);
	fs.writeFileSync(path.join(fixture, "preflight.mjs"), `import { sessions } from './state.mjs';\nexport async function resolveSubagentLaunchContract(input) { const extensions = sessions.get(input.parentSessionId)?.extensions ?? []; return { ok: true, contract: { tools: { requiredExtensionIds: extensions.map(e => e.id) } } }; }\n`);
	const entry = process.env.PI_TOKEN_BUDGET_TEST_SUBAGENTS_MODULE ?? path.join(fixture, "required.mjs");
	const api = await import(pathToFileURL(entry).href) as RequiredExtensionsAPI;
	const preflight = await import(pathToFileURL(publicPreflightEntry(entry)).href) as {
		resolveSubagentLaunchContract(input: Record<string, unknown>): Promise<{ ok: boolean; message?: string; contract?: { tools: { requiredExtensionIds: string[] } } }>;
	};
	const agentsDir = path.join(temp, ".pi", "agents"); fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "budget-probe.md"), "---\nname: budget-probe\ndescription: Offline launch contract test\ntools: read\n---\nReturn a short answer.\n");
	const task = new TaskRegistry({ sessionDir: temp, sessionId: "parent", sessionFile: path.join(temp, "parent.jsonl") });
	assert.notEqual(task.agent.sessionId, task.agent.sessionKey, "file-backed sessions must exercise distinct runtime and storage identities");
	const launchTools = async (parentSessionId: string) => {
		const result = await preflight.resolveSubagentLaunchContract({ agent: "budget-probe", cwd: temp, agentScope: "project", context: "fresh", skill: false, artifacts: false, intercomBridge: { mode: "off" }, parentSessionId });
		assert.ok(result.ok, result.message);
		assert.ok(result.contract);
		return result.contract.tools;
	};
	const pi = { getAllTools: () => [{ name: "subagent", sourceInfo: { path: path.join(fixture, "index.ts") } }] } as unknown as ExtensionAPI;
	assert.equal(discoverSubagentsAPI(pi), path.join(fixture, "required.mjs"));
	const options = { modulePath: entry };
	const own = await attachSubagents(pi, task, options);
	assert.ok(own);
	const childEntry = path.join(task.context.taskDir, "child-extension.ts");
	const tools = await launchTools(task.agent.sessionId);
	assert.ok(tools.requiredExtensionIds.includes("pi-token-budget"), "launcher lookup by runtime session ID must inherit the required extension");
	// Public preflight exposes required IDs, deliberately omitting their private
	// paths. Real SDK child-entry loading is covered by sdk-context.ts.
	assert.ok(!(await launchTools(task.agent.sessionKey)).requiredExtensionIds.includes("pi-token-budget"), "storage identity must not alias the runtime registration");
	assert.throws(() => api.registerRequiredChildExtensions({ sessionId: task.agent.sessionId, extensions: [] }), /already registered/i, "registration uses runtime session ID");
	assert.ok(fs.readFileSync(childEntry, "utf8").includes(task.context.runId));
	await assert.rejects(attachSubagents(pi, task, options), /already registered/i);
	own.dispose();
	assert.ok(!(await launchTools(task.agent.sessionId)).requiredExtensionIds.includes("pi-token-budget"), "dispose removes the launch requirement");
	const foreign = api.registerRequiredChildExtensions({ sessionId: task.agent.sessionId, extensions: [] });
	await assert.rejects(attachSubagents(pi, task, options), /already registered/i, "must not overwrite another component");
	assert.throws(() => api.registerRequiredChildExtensions({ sessionId: task.agent.sessionId, extensions: [] }), /already registered/i, "foreign registration remains owned");
	assert.equal(await attachSubagents(pi, task, { ...options, enabled: false }), undefined);
	foreign.dispose();
	console.log(`pi-subagents adapter and launch preflight contract passed (${process.env.PI_TOKEN_BUDGET_TEST_SUBAGENTS_MODULE ? "installed public APIs" : "fixture public APIs"})`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
