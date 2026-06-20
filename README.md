# agent-spend

See where your coding-agent tokens go. One local command, no upload.

A unified, local dashboard for **multiple coding agents** — pick an agent in the
header and see its own usage. Auto-detects whatever you have installed.

| Agent | Reads | Tokens | Reasoning | Cache | Est. cost | Rate limit |
|---|---|---|---|---|---|---|
| **Codex** | `~/.codex` sessions | ✓ | ✓ | ✓ | — | ✓ |
| **Claude Code** | `~/.claude/projects` | ✓ | — | ✓ | ✓ | — |
| **Qwen Code** | `~/.qwen/projects/**/chats` | ✓ | ✓ | ✓ | — | — |
| **OpenCode** | `~/.local/share/opencode/opencode.db` (SQLite) | ✓ | ✓ | ✓ | ✓ | — |
| **Gemini CLI** | `~/.gemini` | detected (no per-turn token data) | — | — | — | — |

## Run

```bash
npx agent-spend
```

That's it — it opens a dashboard in your browser. Or from a clone:

```bash
npm install
npm start
```

> The OpenCode adapter reads a SQLite store via Node's built-in `node:sqlite`,
> which needs **Node 22.5+**. Everything else works on Node 18+. OpenCode is
> loaded lazily, so older Node still runs fine for the other agents.

## Options

```bash
agent-spend --port 8080
agent-spend --no-open
agent-spend --codex-home ~/.codex
```

Per-agent homes can be overridden via env: `CODEX_HOME`, `CLAUDE_HOME`,
`QWEN_HOME`, `GEMINI_HOME`.

## Architecture

Each agent is an **adapter** in `src/adapters/` exporting
`{ id, label, mark, accent, capabilities, home, detect, parse }`. Every adapter
normalizes its raw logs into one shared schema and hands them to
`aggregate.buildResult()`, which produces the daily/model/project/tool/weekday
breakdowns and insights. The dashboard reads `capabilities` to show only the
panels an agent supports (rate-limit for Codex, est. cost for Claude, reasoning
for Codex/Qwen, …).

To add an agent, drop a new adapter module in `src/adapters/`, register it in
`src/adapters/index.js`, and the UI picks it up automatically.

- `GET /api/sources` — all known agents + whether their data is present
- `GET /api/data?source=<id>` — normalized dashboard data for one agent
- `GET /api/refresh?source=<id>` — re-parse one agent

## Dashboard

- **Agent switcher** — segmented control of detected agents; per-agent accent/branding.
- **KPI strip** — total / cached tokens, sessions, and an adaptive third stat
  (reasoning, est. cost, or output depending on the agent).
- **Rate-limit panel** (Codex) — live 5-hour and weekly window usage with reset countdowns.
- **Overview** — daily stacked-token chart, model-share donut, top projects, weekday, tools (all hover-interactive).
- **Sessions** — sortable, searchable, model-filterable table; click a row for a drilldown drawer.
- **Drilldown drawer** — every prompt in a session, its turn-by-turn token chart, and tool usage.
- **Prompts** — most expensive prompts across all sessions.
- **Insights** — actionable findings (context pressure, reasoning share, tool-heavy sessions, marathon threads, est. spend, rate-limit pressure), each with a concrete "try this".
- **Share card** — render a 1200×630 PNG of your stats locally (nothing is uploaded).
- Light / dark themes (varna design tokens).

## Notes

Token events expose usage (and, for Codex, rate-limit pressure), not a reliable
per-token invoice. Costs shown for Claude Code are **API-rate estimates**, not
your subscription bill. Reasoning tokens are reported as a subset of output
tokens (`total = input + output`).
