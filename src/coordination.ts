/**
 * Private continuation-ownership coordination protocol.
 *
 * Contract between exactly two extensions in the same session:
 * pi-token-budget (host) and a companion client extension. The host owns window
 * management (checkpoints, fences, rollovers); while a client holds the
 * continuation claim, the host suppresses its own generic post-rollover
 * continuation message so the client can resume with a precise instruction.
 *
 * Design invariants:
 * 1. The claim never changes budget thresholds, the checkpoint fence, notes,
 *    or compaction behavior — only the generic continuation is gated.
 * 2. One active owner per session; the same owner may re-claim idempotently.
 * 3. All payloads are validated by strict shape guards that reject unknown
 *    fields. The protocol carries no version field by design: both
 *    extensions live in the same repository and must be updated atomically.
 * 4. `respond` on the claim payload is transport (a synchronous reply
 *    channel over the event bus), not protocol state; guards ignore it.
 *
 * Phase derivation priority (first match wins):
 *   disabled          plugin disabled
 *   rolling_over      pendingWindow != null || compactionInFlight
 *   checkpoint_required  fallback/checkpoint requested, checkpoint not saved
 *   rollover_pending  pendingNewContext || rolloverRequested
 *   ready             otherwise (reminderDelivered is still "ready": the
 *                     model may ignore a reminder forever, and the client must
 *                     not block on that)
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

export const COORD_CHANNEL_STATE = "pi-token-budget:coordination:state";
export const COORD_CHANNEL_CLAIM = "pi-token-budget:coordination:claim";
export const COORD_CHANNEL_CLAIM_RESULT = "pi-token-budget:coordination:claim-result";
export const COORD_CHANNEL_RELEASE = "pi-token-budget:coordination:release";

export type TokenBudgetPhase = "disabled" | "ready" | "checkpoint_required" | "rollover_pending" | "rolling_over";

const PHASES = new Set<TokenBudgetPhase>([
	"disabled",
	"ready",
	"checkpoint_required",
	"rollover_pending",
	"rolling_over",
]);

export interface TokenBudgetCoordinationState {
	sessionId: string;
	windowId: string;
	phase: TokenBudgetPhase;
	/** Monotonic within the extension instance + session; resets on session_start. */
	sequence: number;
	continuationOwner?: string;
	previousWindowId?: string;
	error?: string;
}

export interface TokenBudgetContinuationClaim {
	sessionId: string;
	ownerId: string;
	source: string;
}

export interface TokenBudgetClaimResult {
	sessionId: string;
	ownerId: string;
	accepted: boolean;
	reason?: "disabled" | "session_mismatch" | "already_claimed";
}

export interface TokenBudgetContinuationRelease {
	sessionId: string;
	ownerId: string;
}

/** Transport-wrapped claim: `respond` delivers the synchronous result. */
export interface ClaimRequest extends TokenBudgetContinuationClaim {
	respond(result: TokenBudgetClaimResult): void;
}

const CLAIM_REASONS = new Set(["disabled", "session_mismatch", "already_claimed"]);

/** Required keys present, no keys outside required ∪ optional (unknown fields rejected). */
function hasValidKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
	const allowed = new Set([...required, ...optional]);
	const actual = Object.keys(value);
	return actual.every((k) => allowed.has(k)) && required.every((k) => k in value);
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isCoordinationState(value: unknown): value is TokenBudgetCoordinationState {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!hasValidKeys(v, ["sessionId", "windowId", "phase", "sequence"], ["continuationOwner", "previousWindowId", "error"])) {
		return false;
	}
	if (!isString(v.sessionId) || !isString(v.windowId)) return false;
	if (typeof v.phase !== "string" || !PHASES.has(v.phase as TokenBudgetPhase)) return false;
	if (typeof v.sequence !== "number" || !Number.isInteger(v.sequence) || v.sequence < 0) return false;
	if (v.continuationOwner !== undefined && !isString(v.continuationOwner)) return false;
	if (v.previousWindowId !== undefined && !isString(v.previousWindowId)) return false;
	if (v.error !== undefined && !isString(v.error)) return false;
	return true;
}

export function isContinuationClaim(value: unknown): value is TokenBudgetContinuationClaim {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!hasValidKeys(v, ["sessionId", "ownerId", "source"], [])) return false;
	return isString(v.sessionId) && isString(v.ownerId) && isString(v.source);
}

function isClaimRequest(value: unknown): value is ClaimRequest {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!hasValidKeys(v, ["sessionId", "ownerId", "source", "respond"], [])) return false;
	return isString(v.sessionId) && isString(v.ownerId) && isString(v.source) && typeof v.respond === "function";
}

export function isClaimResult(value: unknown): value is TokenBudgetClaimResult {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!hasValidKeys(v, ["sessionId", "ownerId", "accepted"], ["reason"])) return false;
	if (!isString(v.sessionId) || !isString(v.ownerId) || typeof v.accepted !== "boolean") return false;
	if (v.accepted) return v.reason === undefined;
	return typeof v.reason === "string" && CLAIM_REASONS.has(v.reason);
}

export function isContinuationRelease(value: unknown): value is TokenBudgetContinuationRelease {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!hasValidKeys(v, ["sessionId", "ownerId"], [])) return false;
	return isString(v.sessionId) && isString(v.ownerId);
}

/** Inputs to phase derivation; sourced from the plugin's live state. */
export interface PhaseInputs {
	enabled: boolean;
	pendingWindow: unknown;
	compactionInFlight: boolean;
	checkpointRequired: boolean;
	pendingNewContext: boolean;
	rolloverRequested: boolean;
}

export function derivePhase(input: PhaseInputs): TokenBudgetPhase {
	if (!input.enabled) return "disabled";
	if (input.pendingWindow !== null && input.pendingWindow !== undefined) return "rolling_over";
	if (input.compactionInFlight) return "rolling_over";
	if (input.checkpointRequired) return "checkpoint_required";
	if (input.pendingNewContext || input.rolloverRequested) return "rollover_pending";
	return "ready";
}

/** Phase derivation inputs snapshot from the host's live variables. */
export type PhaseSource = () => PhaseInputs;

/**
 * Host-side coordination state: the owner registry, the rollover owner
 * latch, and snapshot publication. Pure (bus-injected) so tests can run it
 * against a plain event bus without the pi runtime.
 */
export class CoordinationHost {
	private sequence = 0;
	private activeOwner: string | null = null;
	/** Latched when a rollover begins; decides generic-continuation suppression. */
	private rolloverOwnerLatch: string | null = null;
	private lastPublished: TokenBudgetCoordinationState | null = null;
	private readonly events: EventBus;
	private readonly getSessionId: () => string;
	private readonly getWindowId: () => string;
	private readonly phases: PhaseSource;

	constructor(
		events: EventBus,
		getSessionId: () => string,
		getWindowId: () => string,
		phases: PhaseSource,
	) {
		this.events = events;
		this.getSessionId = getSessionId;
		this.getWindowId = getWindowId;
		this.phases = phases;
	}

	getContinuationOwner(): string | null {
		return this.activeOwner;
	}

	/** The latched owner for the rollover currently in progress. */
	getRolloverOwnerLatch(): string | null {
		return this.rolloverOwnerLatch;
	}

	latchRolloverOwner(): void {
		this.rolloverOwnerLatch = this.activeOwner;
	}

	clearRolloverOwnerLatch(): void {
		this.rolloverOwnerLatch = null;
	}

	/** True when the host must suppress its generic post-rollover continuation. */
	suppressGenericContinuation(): boolean {
		return this.rolloverOwnerLatch !== null;
	}

	resetSession(): void {
		this.sequence = 0;
		this.activeOwner = null;
		this.rolloverOwnerLatch = null;
	}

	clearOwner(): void {
		this.activeOwner = null;
	}

	handleClaim(raw: unknown): void {
		if (!isClaimRequest(raw)) return;
		const result = this.evaluateClaim(raw);
		raw.respond(result);
		this.events.emit(COORD_CHANNEL_CLAIM_RESULT, result);
		if (result.accepted) this.publish();
	}

	handleRelease(raw: unknown): void {
		if (!isContinuationRelease(raw)) return;
		if (raw.sessionId !== this.getSessionId()) return;
		if (this.activeOwner === null || this.activeOwner !== raw.ownerId) return;
		this.activeOwner = null;
		this.publish();
	}

	private evaluateClaim(raw: ClaimRequest): TokenBudgetClaimResult {
		const wire: TokenBudgetContinuationClaim = { sessionId: raw.sessionId, ownerId: raw.ownerId, source: raw.source };
		if (wire.sessionId !== this.getSessionId()) {
			return { sessionId: this.getSessionId(), ownerId: wire.ownerId, accepted: false, reason: "session_mismatch" };
		}
		if (!this.phases().enabled) {
			return { sessionId: this.getSessionId(), ownerId: wire.ownerId, accepted: false, reason: "disabled" };
		}
		if (this.activeOwner !== null && this.activeOwner !== wire.ownerId) {
			return { sessionId: this.getSessionId(), ownerId: wire.ownerId, accepted: false, reason: "already_claimed" };
		}
		this.activeOwner = wire.ownerId;
		return { sessionId: this.getSessionId(), ownerId: wire.ownerId, accepted: true };
	}

	publish(options?: { previousWindowId?: string; error?: string }): TokenBudgetCoordinationState {
		const phases = this.phases();
		const state: TokenBudgetCoordinationState = {
			sessionId: this.getSessionId(),
			windowId: this.getWindowId(),
			phase: derivePhase(phases),
			sequence: this.sequence++,
			...(this.activeOwner !== null ? { continuationOwner: this.activeOwner } : {}),
			...(options?.previousWindowId !== undefined ? { previousWindowId: options.previousWindowId } : {}),
			...(options?.error !== undefined ? { error: options.error } : {}),
		};
		this.lastPublished = state;
		this.events.emit(COORD_CHANNEL_STATE, state);
		return state;
	}

	lastSnapshot(): TokenBudgetCoordinationState | null {
		return this.lastPublished;
	}

	/** Subscribe to the claim/release channels. Returns an unsubscribe fn. */
	listen(): () => void {
		const offClaim = this.events.on(COORD_CHANNEL_CLAIM, (data) => this.handleClaim(data));
		const offRelease = this.events.on(COORD_CHANNEL_RELEASE, (data) => this.handleRelease(data));
		return () => {
			offClaim();
			offRelease();
		};
	}
}
