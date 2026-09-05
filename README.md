# pi-token-budget

[![npm version](https://img.shields.io/npm/v/pi-token-budget?style=flat-square)](https://www.npmjs.com/package/pi-token-budget) [![license](https://img.shields.io/npm/l/pi-token-budget?style=flat-square)](LICENSE)

Token-budget context window management for [Pi](https://github.com/earendil-works/pi): **no-summary context rollover** with model-authored notes checkpoints, read-only history recovery, and a post-fallback tool-call fence. It replaces lossy summarization compaction while preserving the current in-flight response.

## At a glance

Long-running Pi sessions can hit a nearly exhausted context window while the model is still trying to work. A fallback prompt alone is not enough: the model may continue issuing `bash`, `read`, or `write` calls for many minutes before the window finally rolls over.

`pi-token-budget` turns that boundary into an enforceable checkpoint:

- the fallback is delivered without aborting the current response;
- once delivered, only one `notes` write/append is admitted;
- all other tools are blocked at the `tool_call` hook;
- a successful checkpoint returns `terminate: true` and requests rollover automatically;
- the next window starts with a fresh bootstrap and recovers the task through notes and history.

Install it with:

```bash
pi install npm:pi-token-budget
```

## Why

| Dimension | pi's default compaction (summary-based) | This extension (token-budget rollover) |
|---|---|---|
| Trigger | System detects the window is nearly full | The model knows the remaining budget in real time and decides when to roll over |
| Rollover content | A lossy LLM summary of history (costs tokens, loses detail) | **Zero summary**: a fresh bootstrap block + recovery protocol |
| Where old conversation goes | Carried on as a summary | Dropped from context, but **addressable by item id** |
| Information continuity | The system summarizes on the model's behalf | The model writes its own notes checkpoints ahead of time |

## How it works

```
Normal operation
  │ The model checks remaining budget anytime via get_context_remaining,
  │ incrementally recording notes as it works
  │ (goal/decisions/progress/learnings/next steps + relevant item ids)
  ▼
Remaining ≤ threshold ──► One-shot reminder (steered to the next model
  │                        boundary, never interrupts the reasoning stream)
  │                        "Checkpoint, then call new_context"
  ├─ Model-initiated: new_context (preferred) ─► rollover at turn boundary
  └─ Model didn't act, pi auto-compaction fires ─► intercepted and
                                                    converted to a forced
                                                    no-summary rollover
New window = bootstrap block (window identity + recovery protocol
  + cross-window user-request index + recently-edited-files index)
  + fresh initial context
  └─ The model reads notes to recover the big picture; details are
     re-read on demand via history by item id
```

After the fallback reaches the branch, the checkpoint fence closes the tool surface until the checkpoint is saved:

```text
fallback delivered ──► notes.write / notes.append (exactly once)
                  └──► other tool calls blocked
checkpoint saved ──► terminate tool batch ──► deferred rollover
```

### Why this exists

In a forensic review of a real Pi session, fallback delivery was followed by approximately 64 tool calls and 15 minutes of delay in one window, then approximately 101 tool calls and 57 minutes of delay in the next. The fence addresses that specific failure mode without interrupting the response that was already in flight.

Rollover carries zero summary: the new window keeps none of the old conversation. The model's big-picture memory comes from notes checkpoints it wrote itself, and details can always be pulled back from the read-only history index — old session content is never lost, it just no longer occupies the context.

## Tools (model-only)

| Tool | Description |
|---|---|
| `get_context_remaining` | Real-time remaining tokens (pull channel) + current window id (`w1`, `w2`, …) |
| `new_context` | Declares a rollover (no parameters); executed after the turn ends, environment state is unaffected |
| `notes` | Virtual-path filesystem: `read/write/append/search/list`, survives across windows, ≤1MB per file; read supports line/char dual pagination; soft warnings on bloat |
| `history` | Read-only index: `list_windows/list_items/read_item/search_contents`, char-level pagination |

All tool output is bounded (char-level pagination + total truncation), so reading history or notes can never blow up the fresh window by accident.

## Install

```bash
pi install npm:pi-token-budget
```

Alternatives:

```bash
# git (pinnable version)
pi install git:github.com/7resp4ss/pi-token-budget@v1.1.3

# Try without installing
pi -e npm:pi-token-budget

# Local development: auto-load via the extensions directory
ln -s /path/to/pi-token-budget/src/index.ts ~/.pi/agent/extensions/pi-token-budget.ts
```

No build step: pi's extension loader (jiti) executes TypeScript directly.

## Compatibility and safety

- Requires a Pi installation that supports Pi Packages and extension `tool_call` hooks.
- Tested against `@earendil-works/pi-coding-agent` / `pi-agent-core` `0.84.4`; newer Pi releases should be checked against the integration contract before production rollout.
- The extension does not collect telemetry or make network requests.
- Notes are stored per session under the session directory; window state and checkpoints are isolated by session id.
- Pi extensions run with the host process's permissions. Review the source before installing any extension, including this one.

## Configuration

Reads the `tokenBudget` key from `~/.pi/agent/settings.json` (or `$PI_AGENT_DIR/settings.json`). Two forms are supported — flat (applies globally) or `defaults` + `models` (per provider/model overrides):

```json
{
	"tokenBudget": {
		"defaults": {
			"reminderRemainingPercent": 0.25,
			"reminderRemainingFloorTokens": 21384,
			"reminderRemainingCeilingTokens": 60000,
			"hardRolloverUsedTokens": 0
		},
		"models": {
			"openai/gpt-5.6-codex": { "hardRolloverUsedTokens": 256000 },
			"anthropic/*":            { "hardRolloverUsedTokens": 160000, "reminderRemainingPercent": 0.3 },
			"google":                 { "reminderRemainingPercent": 0.4 }
		}
	}
}
```

| Field | Meaning |
|---|---|
| `reminderRemainingPercent/Floor/Ceiling` | Remaining threshold for the one-shot reminder: `max(min(percent × window, ceiling), floor)`, clamped to 50% of the window |
| `hardRolloverUsedTokens` | **Absolute hard trigger**: when used tokens ≥ this value, force a no-summary rollover at the next turn boundary (with a 90% hysteresis gate against flapping); e.g. setting 256000 for a 400k window means "start a new window at 256k by default" |
| `maxToolOutputChars` / `notesMaxFileBytes` / `historyItemPreviewChars` | Global output truncation and capacity limits; notes bloat soft-warning thresholds derive from `notesMaxFileBytes` (single file cap/16, total cap/4) — these fields are not model-specific |

Pattern-matching precedence: exact `provider/model-id` > wildcards like `provider/*` > bare `provider` > `*` (case-insensitive; `*` is the only wildcard). Model overrides apply to rollover trigger fields only (`reminderRemainingPercent`, `reminderRemainingFloorTokens`, `reminderRemainingCeilingTokens`, `hardRolloverUsedTokens`).

Environment variables: `PI_TOKEN_BUDGET_DISABLED=1` disables the extension; `PI_TOKEN_BUDGET_REMINDER_PERCENT=0.3` and `PI_TOKEN_BUDGET_HARD_ROLLOVER_TOKENS=256000` are global overrides and take precedence over model-specific settings.

## Subagent compatibility (pi-subagents)

Coexists with [pi-subagents](https://github.com/nicobailon/pi-subagents) (`pi install npm:pi-subagents`) with no extra configuration:

- Subagent processes inherit user extensions by default, so this extension activates in every subagent process
- Window state and notes are strictly isolated by sessionId (`<sessionDir>/pi-token-budget/notes/<sessionId>/`); sessions and subagents can never read or overwrite each other's checkpoints
- Each subagent pays roughly 350 tokens of first-window bootstrap overhead

**Mind the tools whitelist**: pi-subagents' built-in agents declare `tools:` whitelists, and tools not on the list (including this extension's 4 tools) are unavailable inside those subagents — the rollover choreography then degrades to the forced path. To fix it, add the 4 tools to the whitelists of the agents you use: place a full definition in the user-level agents directory (`~/.pi/agent/agents/<name>.md` — a same-named file overrides the built-in definition entirely) and extend the tools line:

```yaml
tools: read, grep, find, ls, bash, edit, write, contact_supervisor, get_context_remaining, new_context, notes, history
```

If you'd rather keep this extension out of subagents, declare `extensions: []` in the agent definition.

## Known limitations

- Models with very small contexts (<16k) hit the fallback path frequently — degraded experience, still correct
- If the session is too short after `new_context` and pi reports "Nothing to compact"/"Already compacted", the rollover request is safely discarded
- Notes are strictly isolated by `sessionId` and are never shared automatically between separate sessions. To reuse a checkpoint in another session, migrate the note content explicitly; this package does not merge cross-session notes.

## Development

```bash
npm install        # Install pinned pi contracts, typebox, and TypeScript test dependencies
npm run typecheck  # strict tsc against the installed pi package types
npm test           # smoke + queue-aware integration + real pi-agent-core contract
```

Implementation details and design invariants live in the source comments and `src/tools/README.md`.

## License

[MIT](LICENSE)
