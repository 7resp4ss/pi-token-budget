# Model tools

Eleven independent functions are registered by `index.ts`. There are no aggregate `notes` / `history` functions and no model-visible delete operation.

- `specs.ts`: Codex function descriptions, individual schemas, execution modes, and namespace descriptions. Notes character paging is the explicit schema extension; runtime schemas omit Codex's encrypted annotations for note text and literal search queries.
- `history.ts`: four history functions with agent/window/role/tool filtering and native image recovery.
- `notes.ts`: five note functions with task-scoped absolute paths, sorting, prefix queries, and atomic writes.
- `get-context-remaining.ts`: full-window versus configured-trigger remaining, current agent and registered task addresses.
- `new-context.ts`: idempotent deferred rollover with an early-termination hint; checkpoint first.
- `deps.ts`: shared registration, runtime validation, error propagation, and bounded output helpers. It does not dispatch an operation parameter.

The deliberate fallback/manual checkpoint fence blocks all calls until one successful write/append to the current agent's own notes. Cross-agent writes work outside that fence. A manual `/compact` cancels its first native attempt, requests one own-agent checkpoint, and retries automatically after that write. Esc cancels the request; a saved checkpoint survives a compaction failure until normal user work resumes. Whole read pages bypass subsequent truncation, so advertised offsets reflect actual content. Text bounds do not count native image data.

History list/search uses safe canonical text, excludes recursive recovery noise by default, and exposes up to three match regions with code-point read coordinates. Explicit tool filters can inspect internal calls/results; known IDs remain readable. Source correlation only uses preceding calls, with namespace/name paired on one callable. Native images appear only on explicit reads. Index rows use a separate `min(maxToolOutputChars, 6000)` cap.

The old aggregate `operation`/`scope`/`kind`/snapshot-cursor API is replaced by the frozen independent schemas. Runtime validation rejects irrelevant fields. Large lists use limit, direction, and agent/window/role/tool filters. Failures throw to the host so both pinned and latest Pi produce real tool errors.

Implementation and per-tool prompt details: [implementation](../../docs/token-budget-implementation.zh-CN.md), [prompts](../../docs/tool-prompts.zh-CN.md). Acceptance: `npm run recovery && npm run sdk-context && npm run subagents-contract`.
