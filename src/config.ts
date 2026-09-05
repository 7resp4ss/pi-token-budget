/**
 * Plugin configuration.
 *
 * Settings are read from the `tokenBudget` key in the agent settings file
 * (~/.pi/agent/settings.json, or $PI_AGENT_DIR/settings.json), with
 * environment variable overrides for quick experimentation.
 *
 * Two shapes are supported:
 *
 * Flat (applies to every model):
 *   { "tokenBudget": { "reminderRemainingPercent": 0.25, ... } }
 *
 * Per-model rollover-trigger overrides (glob patterns over "provider/model-id"):
 *   {
 *     "tokenBudget": {
 *       "defaults": { "reminderRemainingPercent": 0.25 },
 *       "models": {
 *         "anthropic/*":            { "hardRolloverUsedTokens": 160000 },
 *         "openai/gpt-5.6-codex":   { "hardRolloverUsedTokens": 256000 },
 *         "google/gemini-2.5-pro":  { "reminderRemainingPercent": 0.4 }
 *       }
 *     }
 *   }
 *
 * Pattern matching precedence: exact "provider/model-id" > "provider/model-*"
 * or "provider/*" > bare "provider" > "*". Patterns match case-insensitively
 * and only `*` is a wildcard (matches any characters including `/`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TokenBudgetConfig {
	/** Master switch. When false the plugin is inert and pi keeps default compaction. */
	enabled: boolean;
	/**
	 * Remaining-token level that triggers the one-shot reminder per window.
	 * Computed as max(min(reminderRemainingPercent * contextWindow,
	 * reminderRemainingCeilingTokens), reminderRemainingFloorTokens), clamped
	 * to at most 50% of the window. pi's own auto-compaction fires near
	 * contextWindow - reserveTokens(16384), so the floor keeps the reminder
	 * ahead of pi's threshold even for small context windows.
	 */
	reminderRemainingPercent: number;
	reminderRemainingFloorTokens: number;
	reminderRemainingCeilingTokens: number;
	/**
	 * Hard rollover: when context usage (tokens already in the window) reaches
	 * this absolute level, force a no-summary rollover at the next turn
	 * boundary regardless of window size. 0/undefined disables it. Useful for
	 * huge-context models where you want to roll at, say, 256k instead of
	 * filling a 400k window.
	 */
	hardRolloverUsedTokens: number;
	/** Hard cap applied to every tool result before it enters the context. */
	maxToolOutputChars: number;
	/** Per-file size cap for notes. */
	notesMaxFileBytes: number;
	/** Truncate per-item previews in history list_items to this many chars. */
	historyItemPreviewChars: number;
}

export const DEFAULTS: TokenBudgetConfig = {
	enabled: true,
	reminderRemainingPercent: 0.25,
	reminderRemainingFloorTokens: 21384,
	reminderRemainingCeilingTokens: 60000,
	hardRolloverUsedTokens: 0,
	maxToolOutputChars: 12000,
	notesMaxFileBytes: 1_000_000,
	historyItemPreviewChars: 400,
};

export interface ConfigBundle {
	defaults: TokenBudgetConfig;
	models: Record<string, Partial<TokenBudgetConfig>>;
}

const MODEL_OVERRIDE_KEYS = new Set<string>([
	"reminderRemainingPercent",
	"reminderRemainingFloorTokens",
	"reminderRemainingCeilingTokens",
	"hardRolloverUsedTokens",
]);

function agentSettingsPath(): string {
	const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "settings.json");
}

function coerceNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function coerceBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

const NUMBER_KEYS = [
	"reminderRemainingPercent",
	"reminderRemainingFloorTokens",
	"reminderRemainingCeilingTokens",
	"hardRolloverUsedTokens",
	"maxToolOutputChars",
	"notesMaxFileBytes",
	"historyItemPreviewChars",
] as const;

function applySection(
	base: TokenBudgetConfig,
	section: unknown,
	allowedKeys = new Set<string>(NUMBER_KEYS),
	allowEnabled = true,
): TokenBudgetConfig {
	if (!section || typeof section !== "object") return base;
	const s = section as Record<string, unknown>;
	const next = { ...base };
	const enabled = coerceBoolean(s.enabled);
	if (allowEnabled && enabled !== undefined) next.enabled = enabled;
	for (const key of NUMBER_KEYS) {
		if (!allowedKeys.has(key)) continue;
		const n = coerceNumber(s[key]);
		if (n !== undefined && n >= 0) next[key] = n;
	}
	return next;
}

/** Compute the remaining-token level that arms the one-shot reminder. */
export function reminderThreshold(config: TokenBudgetConfig, contextWindow: number): number {
	const proportional = config.reminderRemainingPercent * contextWindow;
	const level = Math.max(
		Math.min(proportional, config.reminderRemainingCeilingTokens),
		config.reminderRemainingFloorTokens,
	);
	const half = Math.floor(contextWindow / 2);
	return Math.min(level, half);
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.toLowerCase()
		.replace(/[.+^${}()|[\]\\?]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

function patternScore(pattern: string, provider: string, modelId: string): number {
	const key = pattern.toLowerCase().trim();
	const target = `${provider.toLowerCase()}/${modelId.toLowerCase()}`;
	const bareProvider = provider.toLowerCase();
	if (key.includes("/")) {
		if (!globToRegExp(key).test(target)) return -1;
		// More specific (fewer wildcards / longer literal) wins.
		const literals = key.split("*").join("").length;
		return 1000 + literals;
	}
	if (key === "*") return 1;
	if (globToRegExp(key).test(bareProvider)) return 100 + key.length;
	return -1;
}

/** Resolve the effective config for the active provider/model. */
export function resolveForModel(bundle: ConfigBundle, provider: string | undefined, modelId: string | undefined): TokenBudgetConfig {
	let resolved = bundle.defaults;
	if (provider && modelId) {
		let best: { score: number; section: Partial<TokenBudgetConfig> } | null = null;
		for (const [pattern, section] of Object.entries(bundle.models)) {
			const score = patternScore(pattern, provider, modelId);
			if (score >= 0 && (!best || score > best.score)) best = { score, section };
		}
		if (best) {
			// Model overrides intentionally cover trigger thresholds only. Tool
			// output and notes capacity remain session-global.
			resolved = applySection(resolved, best.section, MODEL_OVERRIDE_KEYS, false);
		}
	}
	return applyEnvironmentOverrides(resolved);
}

function applyEnvironmentOverrides(config: TokenBudgetConfig): TokenBudgetConfig {
	let next = { ...config };
	const envPercent = coerceNumber(Number(process.env.PI_TOKEN_BUDGET_REMINDER_PERCENT));
	if (envPercent !== undefined && envPercent > 0 && envPercent < 1) {
		next.reminderRemainingPercent = envPercent;
	}
	const envHard = coerceNumber(Number(process.env.PI_TOKEN_BUDGET_HARD_ROLLOVER_TOKENS));
	if (envHard !== undefined && envHard > 0) next.hardRolloverUsedTokens = envHard;
	return next;
}

export function loadConfig(): ConfigBundle {
	let defaults = { ...DEFAULTS };
	const models: Record<string, Partial<TokenBudgetConfig>> = {};
	try {
		const raw = fs.readFileSync(agentSettingsPath(), "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const section = parsed?.tokenBudget;
		if (section && typeof section === "object") {
			const s = section as Record<string, unknown>;
			if (s.defaults || s.models) {
				defaults = applySection(defaults, s.defaults);
				if (s.models && typeof s.models === "object") {
					for (const [pattern, override] of Object.entries(s.models as Record<string, unknown>)) {
						if (override && typeof override === "object") {
							const unsupported = Object.keys(override as Record<string, unknown>).filter(
								(key) => (key === "enabled" || NUMBER_KEYS.includes(key as (typeof NUMBER_KEYS)[number])) && !MODEL_OVERRIDE_KEYS.has(key),
							);
							if (unsupported.length > 0) {
								console.warn(
									`pi-token-budget: model config "${pattern}" ignores global-only fields: ${unsupported.join(", ")}`,
								);
							}
							models[pattern] = override as Partial<TokenBudgetConfig>;
						}
					}
				}
			} else {
				// Flat shape: applies to every model.
				defaults = applySection(defaults, s);
			}
		}
	} catch {
		// Missing or invalid settings file: keep defaults.
	}

	if (process.env.PI_TOKEN_BUDGET_DISABLED === "1") defaults.enabled = false;
	return { defaults, models };
}
