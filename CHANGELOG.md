# Changelog

## 2.0.1 — 2026-11-06

- Remove provider-facing `encrypted` annotations from note writes and literal searches. Notes and search queries use ordinary string parameters; tool names, workflow guidance, and checkpoint fencing stay the same.

## 2.0.0 — 2026-11-06

### Breaking changes

- Replaced the aggregate `notes` and `history` tools with eleven independent functions. The old aggregate `operation`, `scope`, `kind`, and snapshot cursor interface is no longer supported.
- Each function has its own validated parameters, filters, sorting, required fields, and execution mode. Read tools may run in parallel; note mutations and `new_context` run sequentially.

### Migration from 1.x

Update agent tool allowlists and prompts to use:

```text
history_list_windows, history_list_items, history_read_item, history_search_contents,
notes_list_files_by_prefix, notes_read_file, notes_search_contents,
notes_append_to_file, notes_write_file, get_context_remaining, new_context
```

Call the relevant function directly instead of passing an `operation` to `notes` or `history`. For a direct history read, provide both the window ID and item ID. Configure the full names above on child agents that use tool allowlists, then reload the extension. The deliberately strict checkpoint fence still admits only a successful write or append to the current agent's own notes before rollover.

### Added and fixed

- Task-scoped agent addresses, cross-agent notes/history, and historical image content blocks, with unrelated root tasks kept separate.
- Optional pi-subagents integration through its public required-child-extensions API, using the runtime parent session ID. Standalone use does not require pi-subagents.
- Stable workflow guidance in the Pi system prompt, with the direct instruction: `Take incremental notes while you work so you do not miss important info.`
- A new-window notes index with exact readable paths, sizes, and update times. The index is most-recently-updated first, capped at 25 files and 6000 Unicode characters, and contains no note bodies.
- Bounded history recovery with canonical text, Unicode read coordinates, source-tool filters, and explicit access to internal tool records.
- Manual `/compact` saves a checkpoint before automatic rollover and preserves the existing cancellation, retry, and continuation behavior.

### Packaging

- Limited npm contents to runtime TypeScript, the license, release notes, and current documentation. Tests, fixtures, internal scripts, and CI files are excluded.
- Removed obsolete fidelity reports, evidence, and probes for the old four-tool version.
