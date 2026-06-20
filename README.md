# codex-spend

See where your Codex tokens go. One local command, no upload.

## Run

```bash
npm install
npm start
```

Or after linking locally:

```bash
npm link
codex-spend
```

## Options

```bash
codex-spend --port 8080
codex-spend --no-open
codex-spend --codex-home ~/.codex
```

## What It Reads

`codex-spend` reads local Codex state from `CODEX_HOME`, defaulting to `~/.codex`:

- `sessions/**/*.jsonl`
- `archived_sessions/*.jsonl`
- `session_index.jsonl`
- `history.jsonl`

It serves a localhost dashboard with token usage by session, day, model, project, weekday, and tool. Data stays on your machine.

## Dashboard

- **Stat cards** — total / cached / reasoning tokens, sessions, tool calls, avg per prompt.
- **Rate-limit panel** — live 5-hour and weekly window usage with reset countdowns, read from Codex's own `token_count` events (updates in place).
- **Daily usage** — stacked bars split into fresh input, cached input, reasoning, and visible output.
- **Model share** donut, **top projects**, **tools**, and **busiest weekday** breakdowns.
- **Insights** — actionable findings (context-window pressure, reasoning share, tool-heavy sessions, marathon threads, rate-limit pressure, etc.), each with a concrete "try this".
- **Drilldown** — click any session to inspect every prompt, its turn-by-turn token chart, and tool usage.
- **Share card** — render a 1200×630 PNG of your stats locally (nothing is uploaded).
- Light / dark themes (varna design tokens), model filter, sortable + searchable session table.

## Notes

Codex local token events expose token usage and rate-limit pressure, not a reliable per-token invoice. This dashboard therefore reports token usage rather than pretending to calculate dollars. Reasoning tokens are reported as a subset of output tokens (`total = input + output`).
