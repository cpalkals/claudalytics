<p align="center">
  <img src="assets/logo.svg" width="120" height="120" alt="Claudalytics logo">
</p>

<h1 align="center">claudalytics</h1>

> Fork of [metrascope](https://github.com/Buckibarnes17/metrascope) by Keshav,
> rebranded for internal use. Not published to npm — run it straight from this
> repo (see below). MIT licensed, original copyright retained in
> [LICENSE](./LICENSE).

See where your coding-agent tokens go. One local command, no upload.

A unified, local dashboard for **multiple coding agents** — pick an agent in the
header and see its own usage. Auto-detects whatever you have installed.

```bash
npx github:cpalkals/claudalytics
```

| Agent | Reads | Tokens | Reasoning | Cache | Est. cost | Rate limit |
|---|---|---|---|---|---|---|
| **Codex** | `~/.codex` sessions | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Claude Code** | `~/.claude/projects` | ✓ | — | ✓ | ✓ | — |
| **Qwen Code** | `~/.qwen/projects/**/chats` | ✓ | ✓ | ✓ | — | — |
| **OpenCode** | `~/.local/share/opencode/opencode.db` (SQLite) | ✓ | ✓ | ✓ | ✓ | — |
| **Gemini CLI** | `~/.gemini` | detected (no per-turn token data) | — | — | — | — |

## Run

```bash
npx github:cpalkals/claudalytics
```

That's it — it opens a dashboard in your browser. You'll just need `git`
installed, since npx clones this repo directly rather than pulling from the
npm registry. No GitHub auth needed — the repo is public.

Or from a clone:

```bash
npm install
npm start
```

> The OpenCode adapter reads a SQLite store via Node's built-in `node:sqlite`,
> which needs **Node 22.5+**. Everything else works on Node 18+. OpenCode is
> loaded lazily, so older Node still runs fine for the other agents.

## Options

```bash
claudalytics --port 8080
claudalytics --no-open
claudalytics --codex-home ~/.codex
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
- `GET /api/data?source=<id>&range=<day|week|month|all>` — normalized dashboard
  data for one agent, scoped to a date range (default `all`); every breakdown,
  KPI, chart, session, prompt and insight is recomputed for that range server-side
- `GET /api/refresh?source=<id>` — re-parse one agent

## Dashboard

- **Agent switcher** — segmented control of detected agents; per-agent accent/branding.
- **Range filter** — Today / Last 7 days / Last 30 days / All time, applied globally
  to every KPI, chart, session, prompt, and insight — not just cost.
- **KPI strip** — total / cached tokens, sessions, and adaptive stats for whatever
  the agent supports (reasoning and/or est. cost, falling back to output share).
- **Rate-limit panel** (Codex) — live 5-hour and weekly window usage with reset countdowns.
- **Overview** — daily stacked-token chart, model-share donut, top projects, weekday, tools (all hover-interactive).
- **Sessions** — sortable, searchable, model-filterable, paginated table (25/50/100/all rows per page); click a row for a drilldown drawer.
- **Drilldown drawer** — every prompt in a session, its turn-by-turn token chart, and tool usage.
- **Prompts** — most expensive prompts across all sessions.
- **Insights** — actionable findings (context pressure, reasoning share, tool-heavy sessions, marathon threads, est. spend, rate-limit pressure), each with a concrete "try this".
- **Auto-refresh** — optional 15s/30s/60s/5m polling to keep the dashboard live, pausing while you're mid-search or the drawer is open.
- **Share card** — render a 1200×630 PNG of your stats locally (nothing is uploaded).
- Light / dark themes (varna design tokens).

## Notes

Token events expose usage (and, for Codex, rate-limit pressure), not an invoice.
Costs shown for Claude Code and Codex are **standard API-rate equivalents**, not
your subscription bill — most Codex CLI usage is covered by a ChatGPT plan rather
than metered per token. The Codex estimate prices fresh, cached, and output tokens
at the matching model's official rate, including the >272K-token long-context
surcharge where applicable. Tokens from unknown models are visibly excluded
instead of being assigned a guessed fallback rate.

Codex's local token events currently do not expose cache-write token counts, so
the estimate cannot include separately billed cache writes. Reasoning tokens are
reported as a subset of output tokens (`total = input + output`) and are therefore
charged once at the output rate.
