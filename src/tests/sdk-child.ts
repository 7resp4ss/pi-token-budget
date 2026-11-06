/** Detached SDK process loading only the root-owned required extension. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTokenBudgetTask } from "../api.ts";
const [extension, directory] = process.argv.slice(2);
process.env.PI_CODING_AGENT_DIR = directory;
fs.mkdirSync(directory, { recursive: true });
const manager = SessionManager.inMemory(directory);
const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
const itemId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "detached image" }, image], timestamp: Date.now() });
const settings = SettingsManager.inMemory();
let api: ExtensionAPI | undefined;
const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [extension], extensionFactories: [{ name: "identity-observer", factory: pi => { api = pi; } }] });
await loader.reload();
if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, sessionManager: manager, settingsManager: settings, resourceLoader: loader });
const errors: unknown[] = [];
await session.bindExtensions({ mode: "print", onError: e => errors.push(e) });
if (errors.length) throw new Error(JSON.stringify(errors));
console.log(JSON.stringify({ ...getTokenBudgetTask(api!)!, itemId }));
session.dispose();
