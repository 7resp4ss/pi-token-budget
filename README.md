# pi-token-budget

[![npm version](https://img.shields.io/npm/v/pi-token-budget?style=flat-square)](https://www.npmjs.com/package/pi-token-budget) [![license](https://img.shields.io/npm/l/pi-token-budget?style=flat-square)](LICENSE)

**No-summary context rollover for [Pi](https://github.com/earendil-works/pi), inspired by Codex's `token_budget` workflow ([#27488](https://github.com/openai/codex/pull/27488)).**

The model saves its progress in durable notes, starts a fresh context window, and retrieves past details from read-only history. This replaces Pi's summary-based compaction while keeping the task's working state under the model's control.

## Install

```bash
pi install npm:pi-token-budget
```

Or try it without installing:

```bash
pi -e npm:pi-token-budget
```

Requires Pi Packages and extension `tool_call` hooks. No build step is needed.

## Usage

The extension manages context rollover automatically:

1. As the window fills, a reminder asks the model to save a checkpoint and call `new_context`.
2. If the fallback is reached, a checkpoint fence blocks further task tools until the model saves its notes, then requests rollover automatically.
3. In the fresh window, the model reads its checkpoint and recovers missing details from history.

Use Pi's `/compact` command to request a checkpoint and a fresh window manually. Press Esc to cancel. Rollover leaves the filesystem and environment intact.

During ordinary work, the model decides when to take notes. Rollover happens at an eligible Pi boundary; an actual context overflow uses the latest available checkpoint and history.

## Configuration

Defaults work out of the box. To request rollover at a specific used-token threshold, set `tokenBudget` in `~/.pi/agent/settings.json`:

```json
{
  "tokenBudget": {
    "hardRolloverUsedTokens": 256000
  }
}
```

The hard trigger is disabled by default (`0`). Set `PI_TOKEN_BUDGET_DISABLED=1` to disable the extension. All settings and per-model overrides are described in [src/config.ts](src/config.ts).

## Documentation

- [Tools and workflow prompts](docs/tool-prompts.zh-CN.md)
- [Implementation, recovery, and pi-subagents integration](docs/token-budget-implementation.zh-CN.md)
- [Validation results](docs/implementation-acceptance.zh-CN.md)
- [Releases and migration from 1.x](CHANGELOG.md)

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

[MIT](LICENSE)
