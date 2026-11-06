# pi-token-budget

[![npm version](https://img.shields.io/npm/v/pi-token-budget?style=flat-square)](https://www.npmjs.com/package/pi-token-budget) [![license](https://img.shields.io/npm/l/pi-token-budget?style=flat-square)](LICENSE)

Token-budget context window management for [Pi](https://github.com/earendil-works/pi): **no-summary context rollover** with model-authored notes checkpoints, read-only history recovery, and a checkpoint tool-call fence. It replaces lossy summarization compaction while preserving the current in-flight response. Replaces pi's summarization compaction with the mechanism pioneered by codex's `token_budget` feature (#27488 series).

## At a glance

Long-running Pi sessions can hit a nearly exhausted context window while the model is still trying to work. A fallback prompt alone is not enough: the model may continue issuing `bash`, `read`, or `write` calls for many minutes before the window finally rolls over.

`pi-token-budget` turns that boundary into an enforceable checkpoint:

- the fallback is delivered without aborting the current response;
- once delivered, only one `notes_write_file` / `notes_append_to_file` to the current agent’s own notes is admitted;
- all other tools are blocked at the `tool_call` hook;
- a successful checkpoint returns `terminate: true` and requests rollover automatically;
- the next window starts with a fresh bootstrap and recovers the task through notes and history.

Install it with:

```bash
pi install npm:pi-token-budget
```

## Upgrading from 1.x

Version 2.0.0 replaces the aggregate `notes` and `history` tools with eleven independent functions. Update agent tool allowlists and any instructions that call the old tools; the old `operation`, `scope`, `kind`, and snapshot cursor arguments are no longer accepted. The full tool names and their behavior are listed below. `new_context` and `get_context_remaining` keep their names.

The release adds task-scoped agent addresses, cross-agent notes/history, historical image recovery, system workflow guidance, and an existing-notes index after each context-window reset. See [CHANGELOG.md](CHANGELOG.md) for migration and release details.

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
  + existing-notes index + cross-window user-request index
  + recently-edited-files index)
  + fresh initial context
  └─ The model reads notes to recover the big picture; details are
     re-read on demand via history by item id
```

After a fallback or manual checkpoint request reaches the branch, the checkpoint fence closes the tool surface until the checkpoint is saved:

```text
fallback/manual checkpoint delivered ──► notes_write_file / notes_append_to_file to own notes (exactly once)
                  └──► other tool calls blocked
checkpoint saved ──► terminate tool batch ──► deferred rollover
```

### Manual `/compact`

When Pi has enough history to prepare a compaction, its built-in `/compact` command is treated as an explicit save-and-rollover request, independent of the remaining-context threshold:

1. The first native compaction attempt is cancelled and a dedicated checkpoint turn starts with recent item ids attached.
2. The model may make exactly one successful `notes_write_file` or `notes_append_to_file` to its own notes; it does not need to call `new_context`.
3. A successful write terminates that tool batch, retries compaction automatically, and resumes unfinished work in the fresh window. If the checkpoint records no unfinished work, the continuation waits for the user.

Pressing Esc during the checkpoint turn cancels this manual request and stale checkpoint instructions are filtered from later model contexts. If the note succeeds but compaction itself fails, another `/compact` reuses that checkpoint; any normal user message invalidates it and reopens ordinary tools. Repeated `/compact` commands before prompt delivery collapse into one request. Pi currently renders the deliberately cancelled first attempt as `Compaction cancelled` before the checkpoint turn appears; this is a host-level UI consequence of intercepting the built-in command.

An actual context overflow remains an emergency direct rollover because there may no longer be enough room for another model-authored checkpoint.

### Why this exists

After fallback delivery, the model can continue issuing tools without saving a checkpoint. The fence makes that boundary enforceable while allowing the current response to finish.

Rollover carries zero summary: the new window keeps none of the old conversation. The model's big-picture memory comes from notes checkpoints it wrote itself, and details can always be pulled back from the read-only history index — old session content is never lost, it just no longer occupies the context.

## Tools (model-only)

The model receives **11 independent functions**. `notes` and `history` describe groups; they are no longer aggregate tools with an `operation` parameter.

| Tool | Execution | Behavior |
|---|---|---|
| `history_list_windows` | parallel | Agent windows, item counts, limit and direction |
| `history_list_items` | parallel | Agent/window/role/tool filters, per-item previews |
| `history_read_item` | parallel | Required window + item ID, Unicode paging, native historical image blocks |
| `history_search_contents` | parallel | Literal search with independent agent/window/role/tool filters |
| `notes_list_files_by_prefix` | parallel | String-prefix listing, name/creation/update sorting and direction |
| `notes_read_file` | parallel | Whole file or line range, plus Pi character paging |
| `notes_search_contents` | parallel | Literal matching lines; optional newest-created-file first |
| `notes_append_to_file` | sequential | Exact append, cross-process lock and atomic commit |
| `notes_write_file` | sequential | Create/replace; empty text is valid |
| `get_context_remaining` | parallel | Full-window remaining, configured hard-trigger remaining, window/agent/task identity |
| `new_context` | sequential | Idempotent rollover request with `terminate: true`; save checkpoint first |

Function descriptions and original field instructions match the frozen Codex reference. Pi uses portable flat names in place of namespaces. Notes retain optional character paging as a Pi extension. Runtime schemas omit Codex's `encrypted` annotations: note text and literal search queries use ordinary strings. Defaults and local output bounds are documented; Codex's backend defaults are not assumed.

Relative note paths belong to the current agent. Absolute `/root/.../notes/<path>` paths and `history_*`'s `agent_name` can address registered agents in the **same root task**. Ordinary unrelated sessions remain isolated even in the same cwd. A supplied window ID is always checked when reading an item.

### Prompts and anchors

Stable workflow guidance and namespace descriptions enter Pi's chained system prompt through `before_agent_start`. Codex's original workflow role is developer; this is a public Pi extension adaptation. Dynamic identity/reminder/fallback/manual-checkpoint/continuation remains custom control data, hidden from normal display. Notes and recovered conversation data never enter system guidance.

The workflow uses the direct instruction "Take incremental notes while you work so you do not miss important info." Each new-window bootstrap also lists the current agent's existing note paths, byte sizes, and update times, with the most recently updated files first. The snapshot contains at most 25 files and 6000 characters, preserves complete paths for `notes_read_file`, and points to `notes_list_files_by_prefix` for omitted files or a refreshed listing. Note bodies are read on demand. Empty stores and listing failures are reported separately; a failed listing does not block rollover.

Recoverable non-assistant model-context copies get real trailing `[id: ...]` markers. The plugin does not alter persisted originals. Reminder/fallback/manual-checkpoint indexes include windows, and checkpoints must save window/item anchors **before** `new_context`. Its confirmation does not ask for a late notes append.

Reads return complete bounded pages with accurate Unicode code-point offsets. History indexes have a tighter `min(maxToolOutputChars, 6000)` character cap and stop on whole JSON rows. Text limits do not count native image attachments. See the [implementation guide](docs/token-budget-implementation.zh-CN.md) and [full per-tool prompts](docs/tool-prompts.zh-CN.md).

### Precise history recovery

Each session entry has one canonical safe text. Structured thinking and nested tool-result blocks are excluded. Search returns up to three located regions per item; each region supplies `matches` and `offset_chars` / `limit_chars` for a direct `history_read_item` call with the same window and item IDs. Offsets use Unicode code points, so emoji are never split. Tool results resolve their source from preceding calls before falling back to their own `toolName`.

Ordinary list/search recovery filters token-budget controls and notes/history calls/results before applying the item limit. An explicit `tool_namespace` or `tool_name` filter can inspect those tool records, and any known item remains directly readable. The currently executing history call is excluded from its own agent's results. Every function validates its fields independently; unknown or irrelevant parameters produce a corrective tool error.

The eleven Codex schemas replace the earlier aggregate tool's `operation`, `scope`, `kind`, and snapshot cursor interface. Large result sets are bounded by limit, direction, and agent/window/role/tool filters. Persisted aggregate guidance receives one request-local migration hint.

## Install

```bash
pi install npm:pi-token-budget
```

Alternatives:

```bash
# git (pinnable version)
pi install git:github.com/7resp4ss/pi-token-budget@v2.0.1

# Try without installing
pi -e npm:pi-token-budget

# Local development: auto-load via the extensions directory
ln -s /path/to/pi-token-budget/src/index.ts ~/.pi/agent/extensions/pi-token-budget.ts
```

No build step: pi's extension loader (jiti) executes TypeScript directly.

## Compatibility and safety

- Requires a Pi installation that supports Pi Packages and extension `tool_call` hooks.
- Pinned development tests use `@earendil-works/pi-coding-agent` / `pi-agent-core` `0.84.4`; CI also checks the latest stable Pi packages for API drift before production rollout.
- The extension does not collect telemetry or make network requests.
- A root-task registry controls cross-agent access. Existing notes remain in place; new child notes and historical records are anchored in root-task storage. Window state remains session-specific.
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
| `reminderRemainingPercent/Floor/Ceiling` | Remaining threshold for the one-shot reminder: `max(min(percent × window, ceiling), floor)`, clamped to 50% of the window; percent must be strictly between 0 and 1 |
| `hardRolloverUsedTokens` | **Absolute hard trigger**: when used tokens ≥ this value, force a no-summary rollover at the next turn boundary (with a 90% hysteresis gate against flapping); e.g. setting 256000 for a 400k window means "start a new window at 256k by default" |
| `maxToolOutputChars` / `notesMaxFileBytes` / `historyItemPreviewChars` | Global text output and capacity limits; values must be at least 1; notes bloat soft-warning thresholds derive from `notesMaxFileBytes` (single file cap/16, total cap/4) — these fields are not model-specific |

Pattern-matching precedence: exact `provider/model-id` > wildcards like `provider/*` > bare `provider` > `*` (case-insensitive; `*` is the only wildcard). Model overrides apply to rollover trigger fields only (`reminderRemainingPercent`, `reminderRemainingFloorTokens`, `reminderRemainingCeilingTokens`, `hardRolloverUsedTokens`).

Environment variables: `PI_TOKEN_BUDGET_DISABLED=1` disables the extension; `PI_TOKEN_BUDGET_REMINDER_PERCENT=0.3` and `PI_TOKEN_BUDGET_HARD_ROLLOVER_TOKENS=256000` are global overrides and take precedence over model-specific settings.

## Subagent compatibility (pi-subagents)

The optional adapter discovers an installed [pi-subagents](https://github.com/nicobailon/pi-subagents) from tool source metadata and uses its public `required-child-extensions` API. It writes a root-task-specific child extension **inside this project's task storage**, then registers that path under the parent's Pi runtime session ID for child loading. The separate file-based session key is used for durable storage, not the launch registry. No Pi core or pi-subagents source changes are required. Foreground SDK sessions and detached processes can load the same entry and join the task across worktrees; descendants inherit it.

If discovery is unavailable, set `PI_TOKEN_BUDGET_SUBAGENTS_MODULE` to the installed package directory or its public required-child-extensions module. Another launcher can explicitly pass a task using `createTokenBudgetExtension` / `getTokenBudgetTask` from `pi-token-budget/api`; see the implementation guide. Automatic addresses are stable `/root/agent_<session-identity-hash>` names; explicit registration supports deeper hierarchical addresses.

Ambient loading and the generated entry deduplicate to one state machine and eleven tools. The adapter never overwrites another component's required-extension registration. A conflict emits a diagnostic so the owning launcher can combine its entries.

**Tools and extension policy still apply.** Required loading does not grant tools excluded by an agent whitelist or bypass `denyExtensions`. Add the eleven names to the agent definitions you intend to support:

```yaml
tools: read, bash, edit, write, history_list_windows, history_list_items, history_read_item, history_search_contents, notes_list_files_by_prefix, notes_read_file, notes_search_contents, notes_append_to_file, notes_write_file, get_context_remaining, new_context
```

The fallback/manual checkpoint fence deliberately blocks all tools, including read-only recovery and `new_context`, before an own-agent checkpoint succeeds. Cross-agent note writes are available outside that fence.

## Continuation coordination

When a companion client extension is installed in the same session, the two extensions coordinate over the shared extension event bus with a small private protocol (`src/coordination.ts`):

- the client extension claims **continuation ownership** when its audit loop is armed (synchronous request/reply, `respond` callback as transport)
- while the claim is held, pi-token-budget **suppresses its own generic post-rollover continuation message** for a rollover that started under that owner, so the client can resume with its precise repair instruction instead
- one active owner per session; the same owner re-claims idempotently; claims from other sessions are rejected with `session_mismatch`
- the claim never changes budget thresholds, the checkpoint fence, notes, or compaction behavior — only the generic continuation is gated

Guarantees: payloads are validated by strict shape guards (including rejection of unknown claim fields); there is deliberately **no version field** — both extensions are updated atomically; if either side is absent or disabled, everything degrades to the previous single-extension behavior. A non-aborted rollover failure clears transient rollover state before publishing a final snapshot with the real phase (`ready`, `checkpoint_required`, or `rollover_pending` when a saved manual checkpoint is reusable) and the error, so continuation owners never remain stuck on a stale `rolling_over` snapshot. An extension-cancelled compact attempt (`aborted: true`) preserves the hard/new-context rollover intent for the next settled boundary. Host-side state is pure and bus-injected, so the protocol is fully covered by `npm run coordination && npm run coordination-integration`.

## Known limitations

- `terminate: true` shortens an all-terminating tool batch. Mixed batches and queued steer/follow-up messages may continue sampling before Pi reaches an eligible rollover boundary. This plugin does not guarantee Codex-equivalent rollover timing.
- The budget engine retains Pi triggers and the deliberate fence; it does not reproduce Codex total/body-after-prefix budgeting and fallback-buffer accounting.
- Cross-agent history reads use committed journal snapshots and may lag the active agent until the next context/settled boundary. Native image contents are preserved; text-only models receive capability information instead.

- Models with very small contexts (<16k) hit the fallback path frequently — degraded experience, still correct
- If the session is too short after `new_context` and pi reports "Nothing to compact"/"Already compacted", the rollover request is safely discarded
- Cross-agent sharing requires the same registered root task. Different tasks do not merge their notes or histories. Imported legacy note directories retain their existing storage lifecycle.
- Branch navigation events (`session_before_tree`, `session_tree`, and `session_before_fork`) are not interpreted as branch-aware window-state migrations. Returning to an older branch can make persisted window ids differ from that branch's history; full branch-aware state handling is deferred.

## Development

```bash
npm install        # Install pinned pi contracts, typebox, and TypeScript test dependencies
npm run typecheck  # strict tsc against the installed pi package types
npm test           # original regression suites + recovery + real SDK contexts + child-extension contracts
```

Implementation details: [guide](docs/token-budget-implementation.zh-CN.md), [tool and workflow prompts](docs/tool-prompts.zh-CN.md), [acceptance results](docs/implementation-acceptance.zh-CN.md). The npm package includes runtime TypeScript and current documentation; tests, development scripts, and CI configuration stay in the repository. Obsolete four-tool fidelity reports and probes were removed for 2.0.0.

## License

[MIT](LICENSE)
