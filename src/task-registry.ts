import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { atomicWrite, readJson, withFileLock } from "./storage.ts";

/** Portable registration context. Pass explicitly to createTokenBudgetExtension;
 * descendants can carry it across cwd/worktree/process boundaries. */
export interface TaskContext {
	runId: string;
	taskDir: string;
	parentAgentName?: string;
	agentName?: string;
}

export interface AgentRegistration {
	agentName: string;
	parentAgentName?: string;
	sessionId: string;
	sessionKey: string;
	sessionFile?: string;
	notesRoot: string;
	historyDir: string;
	createdAt: string;
}
interface Registry { version: 1; runId: string; agents: Record<string, AgentRegistration> }
interface Locator { version: 1; runId: string; taskDir: string; agentName: string; sessionKey: string }
export const identityHash = (text: string): string => createHash("sha256").update(text).digest("hex");

export function sessionStorageDir(sessionDir: string): string {
	return path.resolve(sessionDir || path.join(process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "sessions", "token-budget-memory"));
}

export function resolveAgentName(current: string, input?: string | null): string {
	if (input === undefined || input === null) return current;
	const absolute = input.startsWith("/") ? input : `${current}/${input}`;
	const parts = absolute.split("/");
	if (parts[0] !== "" || parts[1] !== "root" || parts.slice(2).some(p => !/^[a-z0-9_]+$/.test(p) || p === "root")) {
		throw new Error(`Invalid agent address: ${input}. Use /root or /root/<lowercase_name>; '..' is unsupported.`);
	}
	return absolute;
}

export class TaskRegistry {
	readonly context: TaskContext;
	readonly agent: AgentRegistration;
	private readonly file: string;

	constructor(input: { sessionDir: string; sessionId: string; sessionFile?: string; task?: TaskContext }) {
		input = { ...input, sessionDir: sessionStorageDir(input.sessionDir) };
		if (!/^[A-Za-z0-9_-]+$/.test(input.sessionId)) throw new Error("Invalid Pi session identity");
		const sessionKey = input.sessionFile ? path.resolve(input.sessionFile) : input.sessionId;
		const locatorFile = path.join(input.sessionDir, "pi-token-budget", "sessions", `${identityHash(sessionKey)}.json`);
		const registered = withFileLock(locatorFile, () => {
			const locator = readJson<Locator>(locatorFile);
			if (locator && (locator.version !== 1 || locator.sessionKey !== sessionKey)) throw new Error("Invalid token-budget task locator");
			if (locator && input.task && (input.task.runId !== locator.runId || path.resolve(input.task.taskDir) !== locator.taskDir)) {
				throw new Error("Session already belongs to another token-budget task");
			}
			const runId = input.task?.runId ?? locator?.runId ?? randomUUID();
			const taskDir = path.resolve(input.task?.taskDir ?? locator?.taskDir ?? path.join(input.sessionDir, "pi-token-budget", "tasks", runId));
			if (!runId || (input.task && !path.isAbsolute(input.task.taskDir))) throw new Error("Task context requires runId and absolute taskDir");
			const file = path.join(taskDir, "registry.json");
			const agent = withFileLock(file, () => {
				const registry = readJson<Registry>(file) ?? { version: 1, runId, agents: {} };
				if (registry.version !== 1 || registry.runId !== runId) throw new Error("Task registry identity mismatch");
				const existing = Object.values(registry.agents).find(a => a.sessionKey === sessionKey);
				if (existing) {
					if (input.task?.agentName && resolveAgentName(input.task.parentAgentName ?? "/root", input.task.agentName) !== existing.agentName) throw new Error("Session agent address is already registered");
					return existing;
				}
				const parent = input.task?.parentAgentName ? resolveAgentName("/root", input.task.parentAgentName) : undefined;
				if (parent && !registry.agents[resolveAgentName("/root", parent)]) throw new Error(`Parent agent is not registered: ${parent}`);
				const agentName = resolveAgentName(parent ?? "/root", input.task?.agentName ?? (input.task ? `agent_${identityHash(sessionKey).slice(0, 24)}` : "/root"));
				if (registry.agents[agentName]) throw new Error(`Agent address already in use: ${agentName}`);
				const legacyNotes = path.join(input.sessionDir, "pi-token-budget", "notes", input.sessionId);
				// Keep existing checkpoints in place. New children use the root
				// task's storage, so deleting a temporary worktree cannot erase them.
				const notesRoot = input.task && !fs.existsSync(legacyNotes)
					? path.join(taskDir, "notes", identityHash(agentName)) : legacyNotes;
				const agent: AgentRegistration = {
					agentName, ...(parent ? { parentAgentName: parent } : {}), sessionId: input.sessionId, sessionKey,
					...(input.sessionFile ? { sessionFile: path.resolve(input.sessionFile) } : {}),
					notesRoot, historyDir: path.join(taskDir, "history", identityHash(agentName)), createdAt: new Date().toISOString(),
				};
				registry.agents[agentName] = agent;
				atomicWrite(file, JSON.stringify(registry));
				return agent;
			});
			atomicWrite(locatorFile, JSON.stringify({ version: 1, runId, taskDir, agentName: agent.agentName, sessionKey } satisfies Locator));
			return { runId, taskDir, agent };
		});
		this.context = { runId: registered.runId, taskDir: registered.taskDir };
		this.agent = registered.agent;
		this.file = path.join(registered.taskDir, "registry.json");
	}

	listAgents(): AgentRegistration[] {
		const registry = readJson<Registry>(this.file);
		if (!registry || registry.runId !== this.context.runId) throw new Error("Task registry unavailable");
		return Object.values(registry.agents).sort((a, b) => a.agentName.localeCompare(b.agentName));
	}

	resolve(input?: string | null): AgentRegistration {
		const name = resolveAgentName(this.agent.agentName, input);
		const agent = this.listAgents().find(a => a.agentName === name);
		if (!agent) throw new Error(`Agent is not registered in this task: ${name}`);
		return agent;
	}

	resolveNote(input: string | undefined | null, prefix = false): { agent: AgentRegistration; localPath: string } {
		if (input === undefined || input === null || (prefix && input === "")) {
			if (!prefix) throw new Error("path is required");
			return { agent: this.agent, localPath: "" };
		}
		if (!input.startsWith("/")) return { agent: this.agent, localPath: input };
		if (input.endsWith("/")) throw new Error("Empty note path components are unsupported; omit the trailing slash");
		// Match registered addresses first: an agent may itself contain a 'notes' segment.
		for (const agent of this.listAgents().sort((a, b) => b.agentName.length - a.agentName.length)) {
			const base = `${agent.agentName}/notes`;
			if (input === base || input.startsWith(`${base}/`)) {
				const localPath = input === base ? "" : input.slice(base.length + 1);
				if (!prefix && !localPath) throw new Error("A file path is required after /notes/");
				return { agent, localPath };
			}
		}
		throw new Error(`Note address is not registered in this task: ${input}`);
	}
}
