/** Locks the pi-agent-core 0.84.4 steering/follow-up queue contract. */

import * as assert from "node:assert/strict";
import {
	Agent,
	runAgentLoop,
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model = {
	id: "contract-model",
	name: "Contract Model",
	api: "contract-api",
	provider: "contract-provider",
	baseUrl: "http://127.0.0.1.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 256_000,
	maxTokens: 4_096,
} as AgentLoopConfig["model"];

type Assistant = Extract<AgentMessage, { role: "assistant" }>;

function assistant(callNumber: number): Assistant {
	const toolTurn = callNumber <= 200;
	return {
		role: "assistant",
		content: toolTurn
			? [{ type: "toolCall", id: `tool-${callNumber}`, name: "noop", arguments: {} }]
			: [{ type: "text", text: `done-${callNumber}` }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: toolTurn ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function textOf(messages: Array<{ content?: unknown }>): string {
	return messages
		.flatMap((message) => {
			if (typeof message.content === "string") return [message.content];
			if (!Array.isArray(message.content)) return [];
			return message.content.flatMap((content) => {
				if (typeof content !== "object" || content === null) return [];
				const block = content as { type?: string; text?: unknown };
				return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
			});
		})
		.join("\n");
}

const contexts: string[] = [];
let streamCalls = 0;
let toolExecutions = 0;
const streamFn: StreamFn = async (_model, context) => {
	streamCalls++;
	contexts.push(textOf(context.messages as Array<{ content?: unknown }>));
	const message = assistant(streamCalls);
	const done = { type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message } as const;
	return {
		async *[Symbol.asyncIterator]() {
			yield done;
		},
		async result() {
			return message;
		},
	} as never;
};

const noopTool: AgentTool = {
	name: "noop",
	label: "No-op",
	description: "No-op contract tool",
	parameters: Type.Object({}),
	async execute() {
		toolExecutions++;
		return { content: [{ type: "text", text: "ok" }], details: {} };
	},
};

const steer = { role: "user", content: [{ type: "text", text: "STEER-CONTRACT" }], timestamp: Date.now() } as AgentMessage;
const followUp = { role: "user", content: [{ type: "text", text: "FOLLOWUP-CONTRACT" }], timestamp: Date.now() } as AgentMessage;
let steeringDelivered = false;
let followUpDelivered = false;

const context: AgentContext = {
	systemPrompt: "contract",
	messages: [],
	tools: [noopTool],
};

await runAgentLoop(
	[{ role: "user", content: [{ type: "text", text: "START" }], timestamp: Date.now() }],
	context,
	{
		model,
		convertToLlm: (messages) => messages as never,
		getSteeringMessages: async () => {
			if (!steeringDelivered && streamCalls >= 100) {
				steeringDelivered = true;
				return [steer];
			}
			return [];
		},
		getFollowUpMessages: async () => {
			if (!followUpDelivered) {
				followUpDelivered = true;
				return [followUp];
			}
			return [];
		},
	},
	async () => {},
	undefined,
	streamFn,
);

assert.equal(toolExecutions, 200, "the fake run must execute 200 consecutive tool-use turns");
assert.equal(streamCalls, 202, "steer continues mid-run; follow-up adds one turn only after the run would stop");
assert.equal(contexts.findIndex((text) => text.includes("STEER-CONTRACT")), 100, "steer must reach provider call 101");
assert.equal(contexts.findIndex((text) => text.includes("FOLLOWUP-CONTRACT")), 201, "follow-up must wait until provider call 202");
assert.ok(contexts.slice(0, 201).every((text) => !text.includes("FOLLOWUP-CONTRACT")));

// pi exposes queue clearing used by abort/Esc paths; queued messages are
// intentionally memory-only and disappear when the runtime clears them.
const queueAgent = new Agent({
	streamFn,
	initialState: {
		systemPrompt: "contract",
		model,
		thinkingLevel: "off",
		tools: [],
		messages: [],
	},
	convertToLlm: (messages) => messages as never,
});
queueAgent.steer(steer);
queueAgent.followUp(followUp);
assert.equal(queueAgent.hasQueuedMessages(), true);
queueAgent.clearAllQueues();
assert.equal(queueAgent.hasQueuedMessages(), false);

console.log("pi-agent-core contract: all assertions passed");
