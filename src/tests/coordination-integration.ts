/**
 * Dual-extension integration test: the pi-token-budget CoordinationHost and
 * a client-side companion implementation talking over one shared event bus,
 * exactly as they do inside a pi session. Verifies the private contract from
 * both ends: claim round trip, single-owner rule, state visibility, rollover
 * suppression, and load-order independence.
 * Run: node --experimental-strip-types src/tests/coordination-integration.ts
 */

import * as assert from "node:assert/strict";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	COORD_CHANNEL_CLAIM,
	COORD_CHANNEL_RELEASE,
	COORD_CHANNEL_STATE,
	CoordinationHost,
	isCoordinationState,
	type PhaseInputs,
	type TokenBudgetCoordinationState,
} from "../coordination.ts";

/** In-repo test double for the companion client side of the protocol. */
class CoordinationClient {
	private readonly bus: EventBus;
	private states = new Map<string, TokenBudgetCoordinationState>();
	private _installed = false;

	constructor(bus: EventBus) {
		this.bus = bus;
		this.bus.on(COORD_CHANNEL_STATE, (data) => {
			if (!isCoordinationState(data)) return;
			this._installed = true;
			this.states.set(data.sessionId, data);
		});
	}

	get installed(): boolean {
		return this._installed;
	}

	stateFor(sessionId: string): TokenBudgetCoordinationState | undefined {
		return this.states.get(sessionId);
	}

	claim(sessionId: string, ownerId: string, source: string): { status: string; reason?: string } {
		let result: { status: string; reason?: string } = { status: "no_response" };
		this.bus.emit(COORD_CHANNEL_CLAIM, {
			sessionId,
			ownerId,
			source,
			respond(res: { accepted: boolean; reason?: string }) {
				result = res.accepted
					? { status: "accepted" }
					: { status: "rejected", reason: res.reason };
			},
		});
		return result;
	}

	release(sessionId: string, ownerId: string): void {
		this.bus.emit(COORD_CHANNEL_RELEASE, { sessionId, ownerId });
	}
}

class FakeBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	on(channel: string, cb: (data: unknown) => void): () => void {
		if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
		this.handlers.get(channel)!.add(cb);
		return () => this.handlers.get(channel)?.delete(cb);
	}
	emit(channel: string, data: unknown): void {
		for (const cb of [...(this.handlers.get(channel) ?? [])]) cb(data);
	}
}

function makeHost(bus: FakeBus, p: PhaseInputs, getWindowId: () => string = () => "w1", getSessionId = () => "s1"): CoordinationHost {
	const host = new CoordinationHost(
		bus as unknown as EventBus,
		getSessionId,
		getWindowId,
		() => p,
	);
	host.listen();
	return host;
}

function phases(enabled = true): PhaseInputs {
	return {
		enabled,
		pendingWindow: null,
		compactionInFlight: false,
		checkpointRequired: false,
		pendingNewContext: false,
		rolloverRequested: false,
	};
}

// Client created after the host is already listening (typical load order).
{
	const bus = new FakeBus();
	const p = phases();
	const host = makeHost(bus, p);
	const client = new CoordinationClient(bus as unknown as EventBus);
	assert.equal(client.installed, false, "nothing published yet");
	host.publish();
	assert.equal(client.installed, true);
	assert.equal(client.stateFor("s1")?.phase, "ready");

	assert.deepEqual(client.claim("s1", "client:r1", "client"), { status: "accepted" });
	assert.equal(client.stateFor("s1")?.continuationOwner, "client:r1", "owner visible in the next snapshot");

	// Single-owner rule seen from the client side.
	assert.deepEqual(client.claim("s1", "someone-else", "test"), { status: "rejected", reason: "already_claimed" });
	// Idempotent re-claim (e.g. after restart).
	assert.deepEqual(client.claim("s1", "client:r1", "client"), { status: "accepted" });

	// Release then takeover.
	client.release("s1", "client:r1");
	assert.equal(client.stateFor("s1")?.continuationOwner, undefined, "release published");
	assert.deepEqual(client.claim("s1", "someone-else", "test"), { status: "accepted" });
	// Release from the previous owner is ignored.
	client.release("s1", "client:r1");
	assert.equal(host.getContinuationOwner(), "someone-else");

	// Session mismatch.
	assert.deepEqual(client.claim("s2", "client:r2", "client"), { status: "rejected", reason: "session_mismatch" });

	// Disabled host.
	p.enabled = false;
	host.publish();
	assert.equal(client.stateFor("s1")?.phase, "disabled");
	assert.deepEqual(client.claim("s1", "client:r3", "client"), { status: "rejected", reason: "disabled" });
}

// Client created before the host listens (reverse load order): claims still
// work because the bus dispatches to whoever is subscribed at emit time.
{
	const bus = new FakeBus();
	const client = new CoordinationClient(bus as unknown as EventBus);
	assert.deepEqual(client.claim("s1", "client:r1", "client"), { status: "no_response" }, "nobody listening yet");
	const host = makeHost(bus, phases());
	assert.deepEqual(client.claim("s1", "client:r1", "client"), { status: "accepted" });
}

// Rollover lifecycle from the client's perspective: while the host rolls
// over under a latched owner, phases show rolling_over; when the new window
// is ready the client sees a new windowId and can act on it.
{
	const bus = new FakeBus();
	const p = phases();
	let windowId = "w1";
	const host = makeHost(bus, p, () => windowId);
	const client = new CoordinationClient(bus as unknown as EventBus);

	assert.deepEqual(client.claim("s1", "client:r1", "client"), { status: "accepted" });

	// Rollover starts: latch + rolling_over phase.
	host.latchRolloverOwner();
	assert.equal(host.suppressGenericContinuation(), true);
	p.pendingWindow = { pending: true };
	host.publish();
	assert.equal(client.stateFor("s1")?.phase, "rolling_over");

	// Rollover completes: clear latch, new window, previous window recorded.
	p.pendingWindow = null;
	windowId = "w2";
	host.clearRolloverOwnerLatch();
	assert.equal(host.suppressGenericContinuation(), false);
	const ready = host.publish({ previousWindowId: "w1" });
	assert.equal(client.stateFor("s1")?.phase, "ready");
	assert.equal(client.stateFor("s1")?.windowId, ready.windowId);
	assert.equal(client.stateFor("s1")?.previousWindowId, "w1");

	// The claim survives the rollover (single owner for the whole session).
	assert.deepEqual(client.claim("s1", "client:r1", "client"), { status: "accepted" });
}

// Malformed traffic on the shared channels never breaks either side.
{
	const bus = new FakeBus();
	const host = makeHost(bus, phases());
	const client = new CoordinationClient(bus as unknown as EventBus);
	host.publish();
	bus.emit(COORD_CHANNEL_STATE, { garbage: true });
	bus.emit(COORD_CHANNEL_STATE, null);
	assert.equal(client.stateFor("s1")?.phase, "ready", "last valid state kept");
	assert.deepEqual(client.claim("s1", "client:r1", "client"), { status: "accepted" });
}

console.log("coordination-integration: all assertions passed");
