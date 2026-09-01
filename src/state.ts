/**
 * Per-session window state machine.
 *
 * Tracks the window identity chain, the one-shot delivery flags for the
 * current window, and the pending model-requested rollover. State persists
 * next to the session file so restarts/resumes keep window identity stable.
 *
 * Invariants (see README):
 * - One-shot flags reset only when a window rollover commits.
 * - `pendingNewContext` is consumed exactly once (rollover commit or error).
 * - Window ids are opaque short strings the model can pass back unchanged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { BOOTSTRAP_MARKER } from "./prompts.ts";

export interface WindowState {
	version: 1;
	sessionId: string;
	windowNumber: number;
	firstWindowId: string;
	previousWindowId: string | null;
	currentWindowId: string;
	/** One-shot flags for the current window. */
	reminderDelivered: boolean;
	fallbackDelivered: boolean;
	/** Set by the new_context tool; consumed by the rollover. */
	pendingNewContext: boolean;
	/** Fallback prompt delivered; the next auto-compact must roll over. */
	fallbackActive: boolean;
	/**
	 * Hard-rollover latch with hysteresis: stays true after a hard rollover
	 * until observed usage drops below 90% of the hard level. Prevents
	 * re-trigger loops from stale post-rollover usage estimates.
	 */
	hardRolloverLatched: boolean;
}

let idCounter = 0;

/** Short, opaque, collision-unlikely id (8 hex chars + counter suffix). */
export function generateWindowId(): string {
	idCounter = (idCounter + 1) % 0xffff;
	const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
	const ctr = idCounter.toString(16).padStart(4, "0");
	return `w-${rand}${ctr}`;
}

export function stateFilePath(sessionDir: string, sessionId: string): string {
	return path.join(sessionDir, "pi-token-budget", `${sessionId}.json`);
}

export function freshState(sessionId: string): WindowState {
	const first = generateWindowId();
	return {
		version: 1,
		sessionId,
		windowNumber: 1,
		firstWindowId: first,
		previousWindowId: null,
		currentWindowId: first,
		reminderDelivered: false,
		fallbackDelivered: false,
		pendingNewContext: false,
		fallbackActive: false,
		hardRolloverLatched: false,
	};
}

export function loadState(sessionDir: string, sessionId: string): WindowState {
	const file = stateFilePath(sessionDir, sessionId);
	try {
		const raw = fs.readFileSync(file, "utf8");
		const parsed = JSON.parse(raw) as WindowState;
		if (parsed?.version === 1 && parsed.sessionId === sessionId && typeof parsed.currentWindowId === "string") {
			return parsed;
		}
	} catch {
		// fall through to fresh state
	}
	return freshState(sessionId);
}

export function saveState(sessionDir: string, state: WindowState): void {
	const file = stateFilePath(sessionDir, state.sessionId);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	} catch (err) {
		// State persistence is best-effort; in-memory state still works.
		console.error(`pi-token-budget: failed to persist window state: ${String(err)}`);
	}
}

export interface PendingWindow {
	id: string;
	number: number;
}

/**
 * Advance the state for a committed rollover. Called from session_compact
 * only when the compaction entry carries our bootstrap marker.
 */
export function commitRollover(state: WindowState, pending: PendingWindow): WindowState {
	return {
		...state,
		previousWindowId: state.currentWindowId,
		currentWindowId: pending.id,
		windowNumber: pending.number,
		reminderDelivered: false,
		fallbackDelivered: false,
		pendingNewContext: false,
		fallbackActive: false,
		// hardRolloverLatched intentionally survives the rollover (hysteresis).
	};
}

/** A pending rollover that has not yet been committed by session_compact. */
export interface RolloverLedger {
	pending: PendingWindow | null;
}

/**
 * Infer window identity after a state-file loss, from the session branch:
 * every compaction entry carrying our marker opened a new window.
 */
export function inferFromBranch(state: WindowState, branch: Array<{ type: string; summary?: string }>): WindowState {
	const rollovers = branch.filter((e) => e.type === "compaction" && typeof e.summary === "string" && (e.summary as string).includes(BOOTSTRAP_MARKER));
	if (rollovers.length === 0) return state;
	const number = rollovers.length + 1;
	if (number <= state.windowNumber) return state;
	return {
		...state,
		windowNumber: number,
		// Opaque derived id; only used for identity display after state loss.
		currentWindowId: `w-resumed-${number}`,
		previousWindowId: `w-resumed-${number - 1}`,
		reminderDelivered: true, // conservative: avoid duplicate reminders on inference
		fallbackDelivered: true,
		pendingNewContext: false,
		fallbackActive: false,
		hardRolloverLatched: false,
	};
}
