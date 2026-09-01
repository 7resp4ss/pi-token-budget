/**
 * Shared dependencies and helpers for all model-facing tools.
 *
 * ToolDeps is the seam between the orchestration layer (src/index.ts) and
 * the individual tool implementations in this directory: tools never touch
 * plugin state or pi session internals directly, they only see this
 * interface. That keeps each tool file independently testable and
 * self-documenting.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TokenBudgetConfig } from "../config.ts";
import type { HistoryStore } from "../stores/history-store.ts";
import type { NotesStore } from "../stores/notes-store.ts";
import type { WindowState } from "../state.ts";
import { truncate } from "../stores/history-store.ts";

/** Minimal pi surface tools need for registration. */
export type ToolRegistrar = { registerTool(def: unknown): void };

export interface ToolDeps {
	config: TokenBudgetConfig;
	/** Current window state (identity + one-shot flags). */
	getState(): WindowState;
	/** Set the pending rollover request and persist state. */
	requestRollover(): void;
	/** Notes store for the active session. */
	getNotes(): NotesStore;
	/** History index built from the live session branch. */
	buildHistory(ctx: ExtensionContext): HistoryStore;
	/** Fire-and-forget rollover via pi's compaction pipeline (turn boundary only). */
	triggerCompaction(ctx: ExtensionContext): void;
	/** Remaining tokens from live context usage, or null when unknown. */
	remainingTokens(ctx: ExtensionContext): number | null;
}

/** Build a tool result, truncated to the configured output cap. */
export function textResult(text: string, config: TokenBudgetConfig): { content: Array<{ type: "text"; text: string }>; details: unknown } {
	return {
		content: [{ type: "text", text: truncate(text, config.maxToolOutputChars) }],
		details: { tool: "pi-token-budget" },
	};
}

/** Clamp an optional numeric argument into [min, max] with a fallback. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(max, Math.max(min, n));
}

/**
 * Soft bloat warnings for the notes checkpoint space. Checkpoints are
 * designed to be concise (the recovery protocol reads them as a whole);
 * these hints fire well before the hard cap so the model can prune or split
 * while it still matters. Thresholds are derived from notesMaxFileBytes —
 * per file cap/16 (≈64KB at 1MB), total cap/4 (≈256KB) — so there is nothing
 * extra to configure. Primary channel: the budget reminder (guaranteed
 * delivery); secondary channels: notes list and get_context_remaining.
 * Bounded: at most 5 per-file lines + 1 total line. Returns [] when notes
 * are unavailable (session not started).
 */
export function notesBloatWarnings(getNotes: () => NotesStore, config: TokenBudgetConfig): string[] {
	const lines: string[] = [];
	let files: Array<{ path: string; bytes: number }>;
	try {
		files = getNotes().listFiles(undefined, 500);
	} catch {
		return lines;
	}
	const fileWarn = Math.max(1, Math.floor(config.notesMaxFileBytes / 16));
	const totalWarn = Math.max(1, Math.floor(config.notesMaxFileBytes / 4));
	const oversized = files.filter((f) => f.bytes > fileWarn).slice(0, 5);
	for (const f of oversized) {
		lines.push(
			`⚠ note "${f.path}" is ${f.bytes} bytes (> ${fileWarn}): checkpoints work best concise — prune obsolete content or split the file before it approaches the ${config.notesMaxFileBytes} byte cap.`,
		);
	}
	const total = files.reduce((sum, f) => sum + f.bytes, 0);
	if (total > totalWarn) {
		lines.push(
			`⚠ total notes size ${total} bytes across ${files.length} files (> ${totalWarn}): consider deleting obsolete note files (notes list) — recovery reads checkpoints, not archives.`,
		);
	}
	return lines;
}

export function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
	return value;
}

export function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}
