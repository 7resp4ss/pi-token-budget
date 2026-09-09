/**
 * Plugin configuration.
 *
 * Settings are read from the `tokenBudget` key in the agent settings file
 * (~/.pi/agent/settings.json, or the configured Pi agent directory), with
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
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
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

const NUMERIC_KEY_SET = new Set<string>(NUMBER_KEYS);

type ConfigWarningSink = (message: string) => void;

function normalizeNumber(key: string, value: number): number | undefined {
	if (key === "reminderRemainingPercent") {
		return value > 0 && value < 1 ? value : undefined;
	}
	const normalized = Math.floor(value);
	if (key === "maxToolOutputChars" || key === "notesMaxFileBytes" || key === "historyItemPreviewChars") {
		return normalized >= 1 ? normalized : undefined;
	}
	return normalized >= 0 ? normalized : undefined;
}

function sanitizeNumericFields(
	section: Record<string, unknown>,
	allowedKeys: Set<string>,
	warn: ConfigWarningSink,
	source: string,
): Partial<TokenBudgetConfig> {
	const sanitized: Partial<TokenBudgetConfig> = {};
	for (const key of NUMBER_KEYS) {
		if (!allowedKeys.has(key) || !(key in section)) continue;
		const n = coerceNumber(section[key]);
		if (n === undefined) {
			warn(`${source}.${key} must be a finite number; keeping the previous value`);
			continue;
		}
		const normalized = normalizeNumber(key, n);
		if (normalized === undefined) {
			const range =
				key === "reminderRemainingPercent"
					? "strictly between 0 and 1"
					: key === "hardRolloverUsedTokens" || key.includes("FloorTokens") || key.includes("CeilingTokens")
						? "at least 0"
						: "at least 1";
			warn(`${source}.${key} must be ${range}; keeping the previous value`);
			continue;
		}
		(sanitized as Record<string, number>)[key] = normalized;
	}
	return sanitized;
}

function applySection(
	base: TokenBudgetConfig,
	section: unknown,
	allowedKeys = NUMERIC_KEY_SET,
	allowEnabled = true,
	warn: ConfigWarningSink = () => {},
	source = "tokenBudget",
): TokenBudgetConfig {
	if (section === undefined || section === null) return base;
	if (typeof section !== "object") {
		warn(`${source} must be an object; keeping the previous values`);
		return base;
	}
	const s = section as Record<string, unknown>;
	const next = { ...base };
	if (allowEnabled && "enabled" in s) {
		const enabled = coerceBoolean(s.enabled);
		if (enabled === undefined) warn(`${source}.enabled must be boolean; keeping the previous value`);
		else next.enabled = enabled;
	}
	Object.assign(next, sanitizeNumericFields(s, allowedKeys, warn, source));
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
	if (envHard !== undefined && envHard >= 0) next.hardRolloverUsedTokens = Math.floor(envHard);
	return next;
}

function warnAboutEnvironmentOverrides(warn: ConfigWarningSink): void {
	const envPercent = process.env.PI_TOKEN_BUDGET_REMINDER_PERCENT;
	if (envPercent !== undefined) {
		const value = coerceNumber(Number(envPercent));
		if (value === undefined || value <= 0 || value >= 1) {
			warn("PI_TOKEN_BUDGET_REMINDER_PERCENT must be strictly between 0 and 1; ignoring it");
		}
	}
	const envHard = process.env.PI_TOKEN_BUDGET_HARD_ROLLOVER_TOKENS;
	if (envHard !== undefined) {
		const value = coerceNumber(Number(envHard));
		if (value === undefined || value < 0) {
			warn("PI_TOKEN_BUDGET_HARD_ROLLOVER_TOKENS must be at least 0; ignoring it");
		}
	}
}

export function loadConfig(): ConfigBundle {
	let defaults = { ...DEFAULTS };
	const models: Record<string, Partial<TokenBudgetConfig>> = {};
	const warnings: string[] = [];
	const warn: ConfigWarningSink = (message) => warnings.push(message);
	const settingsPath = agentSettingsPath();
	let raw: string | undefined;
	try {
		raw = fs.readFileSync(settingsPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") warn(`could not read ${settingsPath}; keeping defaults where needed`);
		raw = undefined;
	}
	if (raw !== undefined) {
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const section = parsed?.tokenBudget;
			if (section === undefined) {
				// No tokenBudget section is a valid no-op.
			} else if (section && typeof section === "object") {
				const s = section as Record<string, unknown>;
				if (s.defaults || s.models) {
					defaults = applySection(defaults, s.defaults, NUMERIC_KEY_SET, true, warn, "tokenBudget.defaults");
					if (s.models && typeof s.models === "object") {
						for (const [pattern, override] of Object.entries(s.models as Record<string, unknown>)) {
							if (override && typeof override === "object") {
								const unsupported = Object.keys(override as Record<string, unknown>).filter(
									(key) => (key === "enabled" || NUMBER_KEYS.includes(key as (typeof NUMBER_KEYS)[number])) && !MODEL_OVERRIDE_KEYS.has(key),
								);
								if (unsupported.length > 0) {
									warn(`model config "${pattern}" ignores global-only fields: ${unsupported.join(", ")}`);
								}
								models[pattern] = sanitizeNumericFields(
									override as Record<string, unknown>,
									MODEL_OVERRIDE_KEYS,
									warn,
									`tokenBudget.models[${pattern}]`,
								);
							}
						}
					}
				} else {
					// Flat shape: applies to every model.
					defaults = applySection(defaults, s, NUMERIC_KEY_SET, true, warn, "tokenBudget");
				}
			} else {
				warn("tokenBudget must be an object; keeping defaults");
			}
		} catch {
			warn(`could not parse ${settingsPath}; keeping defaults where needed`);
		}
	}

	warnAboutEnvironmentOverrides(warn);
	if (warnings.length > 0) {
		console.warn(`pi-token-budget: configuration warnings: ${warnings.join("; ")}`);
	}
	if (process.env.PI_TOKEN_BUDGET_DISABLED === "1") defaults.enabled = false;
	return { defaults, models };
}
