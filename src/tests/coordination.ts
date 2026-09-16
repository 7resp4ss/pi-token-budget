/**
 * Unit tests for the private continuation-coordination protocol (host side).
 * Pure modules + a fake event bus; no pi runtime needed.
 * Run: node --experimental-strip-types src/tests/coordination.ts
 */

import * as assert from "node:assert/strict";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	COORD_CHANNEL_CLAIM,
	COORD_CHANNEL_CLAIM_RESULT,
	COORD_CHANNEL_RELEASE,
	COORD_CHANNEL_STATE,
	CoordinationHost,
	derivePhase,
	isClaimResult,
	isContinuationClaim,
	isContinuationRelease,
	isCoordinationState,
	type PhaseInputs,
} from "../coordination.ts";

class FakeBus {
	handlers = new Map<string, Set<(data: unknown) => void>>();
	on(channel: string, cb: (data: unknown) => void): () => void {
		if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
		this.handlers.get(channel)!.add(cb);
		return () => this.handlers.get(channel)?.delete(cb);
	}
	emit(channel: string, data: unknown): void {
		for (const cb of [...(this.handlers.get(channel) ?? [])]) cb(data);
	}
}

function inputs(over: Partial<PhaseInputs> = {}): PhaseInputs {
	return {
		enabled: true,
		pendingWindow: null,
		compactionInFlight: false,
		checkpointRequired: false,
		pendingNewContext: false,
		rolloverRequested: false,
		...over,
	};
}

// --- derivePhase priority ---------------------------------------------------

assert.equal(derivePhase(inputs()), "ready");
assert.equal(derivePhase(inputs({ enabled: false, pendingNewContext: true })), "disabled"); // disabled wins over everything
assert.equal(derivePhase(inputs({ pendingWindow: { any: true } })), "rolling_over");
assert.equal(derivePhase(inputs({ compactionInFlight: true })), "rolling_over");
assert.equal(derivePhase(inputs({ pendingWindow: { any: true }, checkpointRequired: true })), "rolling_over"); // rolling_over beats checkpoint
assert.equal(derivePhase(inputs({ checkpointRequired: true, pendingNewContext: true })), "checkpoint_required"); // checkpoint beats rollover_pending
assert.equal(derivePhase(inputs({ pendingNewContext: true })), "rollover_pending");
assert.equal(derivePhase(inputs({ rolloverRequested: true })), "rollover_pending");

// --- state guard -----------------------------------------------------------

assert.ok(isCoordinationState({ sessionId: "s", windowId: "w", phase: "ready", sequence: 0 }));
assert.ok(isCoordinationState({ sessionId: "s", windowId: "w", phase: "ready", sequence: 7, continuationOwner: "client:r1", previousWindowId: "w0", error: "boom" }));
assert.ok(!isCoordinationState({ sessionId: "s", windowId: "w", phase: "ready", sequence: 0, extra: 1 }), "unknown field rejected");
assert.ok(!isCoordinationState({ sessionId: "s", windowId: "w", phase: "ready" }), "missing sequence rejected");
assert.ok(!isCoordinationState({ sessionId: "s", windowId: "w", phase: "sideways", sequence: 0 }), "unknown phase rejected");
assert.ok(!isCoordinationState({ sessionId: "s", windowId: "w", phase: "ready", sequence: -1 }), "negative sequence rejected");
assert.ok(!isCoordinationState({ sessionId: "s", windowId: "w", phase: "ready", sequence: 1.5 }), "fractional sequence rejected");
assert.ok(!isCoordinationState({ sessionId: "s", windowId: "", phase: "ready", sequence: 0 }), "empty strings rejected");
assert.ok(!isCoordinationState(null));
assert.ok(!isCoordinationState("state"));

// --- claim / release guards ------------------------------------------------

assert.ok(isContinuationClaim({ sessionId: "s", ownerId: "o", source: "x" }));
assert.ok(!isContinuationClaim({ sessionId: "s", ownerId: "o", source: "x", respond: () => {} }), "transport respond is not part of the wire shape");
assert.ok(!isContinuationClaim({ sessionId: "s", ownerId: "o" }), "missing source rejected");

assert.ok(isClaimResult({ sessionId: "s", ownerId: "o", accepted: true }));
assert.ok(isClaimResult({ sessionId: "s", ownerId: "o", accepted: false, reason: "already_claimed" }));
assert.ok(!isClaimResult({ sessionId: "s", ownerId: "o", accepted: false, reason: "whatever" }), "reason must be whitelisted");
assert.ok(!isClaimResult({ sessionId: "s", ownerId: "o", accepted: false, reason: null }), "null reason rejected");

assert.ok(isContinuationRelease({ sessionId: "s", ownerId: "o" }));
assert.ok(!isContinuationRelease({ sessionId: "s", ownerId: "o", extra: 1 }));

// --- CoordinationHost ------------------------------------------------------

interface Harness {
	bus: FakeBus;
	host: CoordinationHost;
	phases: PhaseInputs;
	states: Array<Record<string, unknown>>;
	claimResults: Array<Record<string, unknown>>;
	sessionId: string;
	windowId: string;
}

function harness(sessionId = "s1"): Harness {
	const bus = new FakeBus();
	const phases = inputs();
	const h: Harness = {
		bus,
		phases,
		states: [],
		claimResults: [],
		sessionId,
		windowId: "w1",
		host: null as unknown as CoordinationHost,
	};
	h.host = new CoordinationHost(
		bus as unknown as EventBus,
		() => h.sessionId,
		() => h.windowId,
		() => h.phases,
	);
	h.host.listen();
	bus.on(COORD_CHANNEL_STATE, (data) => {
		if (isCoordinationState(data)) h.states.push(data as unknown as Record<string, unknown>);
	});
	bus.on(COORD_CHANNEL_CLAIM_RESULT, (data) => {
		if (isClaimResult(data)) h.claimResults.push(data as unknown as Record<string, unknown>);
	});
	return h;
}

function claim(h: Harness, ownerId: string): { status: string; reason?: string } {
	let reply: unknown;
	h.bus.emit(COORD_CHANNEL_CLAIM, {
		sessionId: h.sessionId,
		ownerId,
		source: "test",
		respond: (result: unknown) => {
			reply = result;
		},
	});
	const result = reply as { accepted: boolean; reason?: string };
	if (!result) return { status: "no_response" };
	return result.accepted ? { status: "accepted" } : { status: "rejected", reason: result.reason };
}

// claim lifecycle
{
	const h = harness();
	assert.deepEqual(claim(h, "client:r1"), { status: "accepted" });
	assert.equal(h.host.getContinuationOwner(), "client:r1");
	assert.deepEqual(claim(h, "client:r1"), { status: "accepted" }, "same owner re-claims idempotently");
	assert.deepEqual(claim(h, "other"), { status: "rejected", reason: "already_claimed" });
	assert.deepEqual(claim(h, "client:r1"), { status: "accepted" }, "still accepted after a foreign rejection");
	// wire-level claim from another session
	let foreign: unknown;
	h.bus.emit(COORD_CHANNEL_CLAIM, { sessionId: "s2", ownerId: "x", source: "test", respond: (r: unknown) => (foreign = r) });
	assert.equal((foreign as { reason?: string }).reason, "session_mismatch");
	// malformed claim payload is ignored, never throws or mutates ownership
	let malformed: unknown;
	h.bus.emit(COORD_CHANNEL_CLAIM, { garbage: true, respond: (r: unknown) => (malformed = r) });
	assert.equal(malformed, undefined);
	assert.equal(h.host.getContinuationOwner(), "client:r1");
	let unknownFieldReply: unknown;
	h.bus.emit(COORD_CHANNEL_CLAIM, {
		sessionId: h.sessionId,
		ownerId: "x",
		source: "test",
		extra: true,
		respond: (r: unknown) => (unknownFieldReply = r),
	});
	assert.equal(unknownFieldReply, undefined, "unknown claim fields are rejected");
	// release by non-owner is ignored
	h.bus.emit(COORD_CHANNEL_RELEASE, { sessionId: h.sessionId, ownerId: "other" });
	assert.equal(h.host.getContinuationOwner(), "client:r1");
	// release by the owner
	h.bus.emit(COORD_CHANNEL_RELEASE, { sessionId: h.sessionId, ownerId: "client:r1" });
	assert.equal(h.host.getContinuationOwner(), null);
	assert.deepEqual(claim(h, "other"), { status: "accepted" }, "released claim can be taken by another owner");
}

// disabled host rejects claims
{
	const h = harness();
	h.phases.enabled = false;
	assert.deepEqual(claim(h, "client:r1"), { status: "rejected", reason: "disabled" });
	assert.equal(h.host.getContinuationOwner(), null, "disabled claim must not register an owner");
}

// publish: sequence monotonic, snapshot fields, owner visibility
{
	const h = harness();
	const first = h.host.publish();
	assert.equal(first.phase, "ready");
	assert.equal(first.sequence, 0);
	assert.ok(!(("continuationOwner" in first) && first.continuationOwner !== undefined), "no owner key when unowned");
	claim(h, "client:r1"); // accepted claims publish an owner-changed snapshot
	const afterClaim = h.states.at(-1) as { sequence: number; continuationOwner?: string };
	assert.equal(afterClaim.continuationOwner, "client:r1");
	assert.equal(afterClaim.sequence, 1);
	const withHistory = h.host.publish({ previousWindowId: "w0", error: "compaction failed" });
	assert.equal(withHistory.previousWindowId, "w0");
	assert.equal(withHistory.error, "compaction failed");
	assert.equal(withHistory.sequence, 2);
	assert.equal(h.host.lastSnapshot(), withHistory);
	assert.deepEqual(h.states.map((s) => s.sequence), [0, 1, 2], "every publish reached the bus");
	// phases map through publish
	h.phases.pendingWindow = { pending: true };
	assert.equal(h.host.publish().phase, "rolling_over");
	h.phases.pendingWindow = null;
	h.phases.checkpointRequired = true;
	assert.equal(h.host.publish().phase, "checkpoint_required");
	h.phases.checkpointRequired = false;
	h.phases.rolloverRequested = true;
	assert.equal(h.host.publish().phase, "rollover_pending");
	h.phases.rolloverRequested = false;
	h.phases.enabled = false;
	assert.equal(h.host.publish().phase, "disabled");
	// sequence stays monotonic without resetSession
	h.sessionId = "s2";
	h.windowId = "w9";
	const next = h.host.publish();
	assert.equal(next.sessionId, "s2");
	assert.equal(next.windowId, "w9");
	assert.equal(next.sequence, 7);
}

// rollover owner latch
{
	const h = harness();
	assert.equal(h.host.suppressGenericContinuation(), false);
	claim(h, "client:r1");
	h.host.latchRolloverOwner(); // rollover begins under this owner
	assert.equal(h.host.getRolloverOwnerLatch(), "client:r1");
	assert.equal(h.host.suppressGenericContinuation(), true);
	h.host.clearOwner(); // owner may step away mid-rollover; the latch holds
	assert.equal(h.host.suppressGenericContinuation(), true, "latch survives owner release");
	h.host.clearRolloverOwnerLatch();
	assert.equal(h.host.suppressGenericContinuation(), false);
}

// resetSession clears owner, latch, and sequence
{
	const h = harness();
	claim(h, "client:r1");
	h.host.latchRolloverOwner();
	h.host.resetSession();
	assert.equal(h.host.getContinuationOwner(), null);
	assert.equal(h.host.getRolloverOwnerLatch(), null);
	assert.equal(h.host.publish().sequence, 0, "sequence reset");
}

// handleClaim emits the claim-result channel too (for observability)
{
	const h = harness();
	claim(h, "client:r1");
	assert.equal(h.claimResults.length, 1);
	assert.equal(h.claimResults[0].accepted, true);
}

console.log("coordination: all assertions passed");
