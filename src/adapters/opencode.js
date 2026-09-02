// OpenCode adapter — reads the SQLite store at ~/.local/share/opencode/opencode.db
// (session/message/part tables; assistant messages carry tokens + cost).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { expandHome, projectFromCwd, clip, localDay } = require('./shared');
const { buildResult, emptyResult, buildPromptBreakdown } = require('./aggregate');

const id = 'opencode';
const label = 'OpenCode';
const mark = 'OC';
const accent = '#3fb6a8';
const capabilities = { cost: true, reasoning: true, rateLimit: false, cache: true, tools: true, contextWindow: false };

function dataDir(options = {}) {
  const explicit = expandHome(options.home || process.env.OPENCODE_DATA);
  if (explicit) return explicit;
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? path.join(xdg, 'opencode') : path.join(os.homedir(), '.local', 'share', 'opencode');
}
function dbPath(options = {}) {
  return path.join(dataDir(options), 'opencode.db');
}
function home(options = {}) {
  return dbPath(options);
}
function detect(options = {}) {
  return fs.existsSync(dbPath(options));
}

function loadSqlite() {
  try { return require('node:sqlite').DatabaseSync; } catch { return null; }
}

// Fallback pricing, $ per token, used only to back-fill turns where OpenCode
// recorded $0 - models with no models.dev entry (custom, local, or proxied
// providers). Rates are the providers' published list prices as of 2026-08-26.
// Anthropic/Google/xAI cache rates follow the standard 1.25x write / 0.1x read
// multipliers; OpenAI bills cache reads at 0.1x and does not charge for writes.
const M = 1e6;
// A base-family rule must not price a named tier it has never heard of: within a
// family the tiers differ by more than 10x (gpt-5.6-luna is $0.20/M input, plain
// gpt-5.6 is $5.00/M), so inheriting a sibling's rate invents a number rather
// than estimating one. `SNAPSHOT` lets a base rule still match its own dated
// releases, while an unrecognised suffix falls through to null / unpriced.
const SNAPSHOT = String.raw`(?:-\d{4}-\d{2}-\d{2}|-\d{6,8})?$`;
const base = (family) => new RegExp(family + SNAPSHOT);
const MODEL_PRICING = [
  // Anthropic
  [/(fable-5|mythos-5)/, { input: 10 / M, output: 50 / M, cacheWrite: 12.50 / M, cacheRead: 1.00 / M }],
  [/(opus-5|opus-4[-.]8|opus-4[-.]7|opus-4[-.]6|opus-4[-.]5)/, { input: 5 / M, output: 25 / M, cacheWrite: 6.25 / M, cacheRead: 0.50 / M }],
  [/opus/, { input: 15 / M, output: 75 / M, cacheWrite: 18.75 / M, cacheRead: 1.50 / M }],
  [/sonnet-5/, { input: 2 / M, output: 10 / M, cacheWrite: 2.50 / M, cacheRead: 0.20 / M }],
  [/sonnet/, { input: 3 / M, output: 15 / M, cacheWrite: 3.75 / M, cacheRead: 0.30 / M }],
  [/haiku-4[-.]5/, { input: 1 / M, output: 5 / M, cacheWrite: 1.25 / M, cacheRead: 0.10 / M }],
  [/haiku/, { input: 0.80 / M, output: 4 / M, cacheWrite: 1.00 / M, cacheRead: 0.08 / M }],
  // OpenAI
  [/gpt-5[-.]5-pro/, { input: 30 / M, output: 180 / M, cacheWrite: 0, cacheRead: 30 / M }],
  [/gpt-5[-.]6-luna/, { input: 0.20 / M, output: 1.20 / M, cacheWrite: 0, cacheRead: 0.02 / M }],
  [/gpt-5[-.]6-terra/, { input: 2.00 / M, output: 12 / M, cacheWrite: 0, cacheRead: 0.20 / M }],
  [base('gpt-5[-.](5|6)'), { input: 5.00 / M, output: 30 / M, cacheWrite: 0, cacheRead: 0.50 / M }],
  [/gpt-5[-.]4-nano/, { input: 0.20 / M, output: 1.25 / M, cacheWrite: 0, cacheRead: 0.02 / M }],
  [/gpt-5[-.]4-mini/, { input: 0.75 / M, output: 4.50 / M, cacheWrite: 0, cacheRead: 0.075 / M }],
  [base('gpt-5[-.]4'), { input: 2.50 / M, output: 15 / M, cacheWrite: 0, cacheRead: 0.25 / M }],
  [base('gpt-5[-.](2|3)'), { input: 1.75 / M, output: 14 / M, cacheWrite: 0, cacheRead: 0.175 / M }],
  [base('gpt-5'), { input: 1.25 / M, output: 10 / M, cacheWrite: 0, cacheRead: 0.125 / M }],
  // Google
  [/gemini-3.*(flash|lite)/, { input: 0.30 / M, output: 2.50 / M, cacheWrite: 0.375 / M, cacheRead: 0.03 / M }],
  [/gemini-3/, { input: 2.00 / M, output: 12 / M, cacheWrite: 2.50 / M, cacheRead: 0.20 / M }],
  [/gemini-2[-.]5-pro/, { input: 1.25 / M, output: 10 / M, cacheWrite: 1.5625 / M, cacheRead: 0.125 / M }],
  [/gemini/, { input: 0.30 / M, output: 2.50 / M, cacheWrite: 0.375 / M, cacheRead: 0.03 / M }],
  // Others
  [/grok/, { input: 3.00 / M, output: 15 / M, cacheWrite: 3.75 / M, cacheRead: 0.75 / M }],
  [/deepseek/, { input: 0.28 / M, output: 1.10 / M, cacheWrite: 0.28 / M, cacheRead: 0.028 / M }],
  [/(qwen3|qwen-3|kimi|glm-4)/, { input: 0.60 / M, output: 2.20 / M, cacheWrite: 0.60 / M, cacheRead: 0.06 / M }],
];

// Returns null for models we have no published rate for, so their tokens are
// reported as unpriced rather than silently costed at somebody else's rate.
function getPricing(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  for (const [rx, pricing] of MODEL_PRICING) if (rx.test(m)) return pricing;
  return null;
}

function estimateCost(model, usage) {
  const pricing = getPricing(model);
  if (!pricing) return null;
  return usage.freshInputTokens * pricing.input
    + usage.cacheWriteTokens * pricing.cacheWrite
    + usage.cachedInputTokens * pricing.cacheRead
    + usage.outputTokens * pricing.output;
}

function safeParse(json) {
  try { return JSON.parse(json); } catch { return {}; }
}

// OpenCode writes one `step-finish` part per model round-trip, each carrying that
// step's tokens + cost. The assistant message's own `data.tokens` is OVERWRITTEN on
// every step (only `cost` accumulates), so a multi-step turn -- any turn with tool
// calls -- reports just the last step's tokens there. Sum the step-finish parts so
// per-turn token volume matches the session rollup columns opencode itself keeps
// (session.tokens_input / tokens_output / tokens_reasoning / tokens_cache_*).
function usageFromParts(parts, d) {
  const steps = parts.filter((p) => p && p.type === 'step-finish' && p.tokens);
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  const acc = { fresh: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const add = (tk, cost) => {
    const cache = tk.cache || {};
    acc.fresh += num(tk.input);
    acc.output += num(tk.output);
    acc.reasoning += num(tk.reasoning);
    acc.cacheRead += num(cache.read);
    acc.cacheWrite += num(cache.write);
    acc.cost += Number.isFinite(Number(cost)) ? Number(cost) : 0;
  };
  if (steps.length) {
    for (const p of steps) add(p.tokens, p.cost);
    // The message's own cost field is already the sum of every step's cost; prefer it
    // when present so we stay aligned with what the OpenCode UI shows.
    if (Number.isFinite(Number(d.cost))) acc.cost = Number(d.cost);
  } else {
    add(d.tokens || {}, d.cost);
  }
  // tokens.input excludes cache reads/writes and tokens.output excludes reasoning
  // (see Session.getUsage in opencode), so both flavors add rather than overlap.
  // Note: OpenCode's OpenAI-chat protocol - which OpenRouter and every other
  // OpenAI-compatible provider use - never reports cache-write tokens. Those are
  // already inside the provider's prompt_tokens, so they show up under fresh
  // input instead: the input total stays right, only the split is lost.
  const input = acc.fresh + acc.cacheRead + acc.cacheWrite;
  const output = acc.output + acc.reasoning;
  return {
    inputTokens: input,
    freshInputTokens: acc.fresh,
    cacheWriteTokens: acc.cacheWrite,
    cachedInputTokens: acc.cacheRead,
    outputTokens: output,
    reasoningOutputTokens: acc.reasoning,
    totalTokens: input + output,
    recordedCost: acc.cost,
  };
}

function toolNameFromPart(d) {
  if (!d) return null;
  const t = String(d.type || '');
  if (t === 'tool' || t.includes('tool')) {
    return d.tool || d.name || d.toolName || (d.toolInvocation && d.toolInvocation.toolName) || 'tool';
  }
  return null;
}

// OpenCode's Task tool runs each helper agent in its own session row, linked to
// the session that spawned it by parent_id. Those are not separate things the
// user started, so we fold a helper's turns into its top-level ancestor instead
// of listing it on its own. Orphans (parent row gone) stay top-level.
function rootSessionId(id, parentById) {
  const seen = new Set([id]);
  let current = id;
  for (let depth = 0; depth < 32; depth += 1) {
    const parent = parentById.get(current);
    if (!parent || !parentById.has(parent) || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
  return current;
}

async function parse(options = {}) {
  const file = dbPath(options);
  const source = {
    id, label, mark, accent, home: file,
    costBasis: 'OpenCode’s own models.dev cost, with published list rates filling the gaps',
    costDisclaimer: 'Per-step cost as OpenCode recorded it; turns it recorded as $0 (custom/local/proxied providers) are back-filled from published list rates. An API-rate ballpark, not a subscription bill — Copilot turns carry an AIU-derived amount instead. OpenAI-compatible providers (OpenRouter among them) do not report cache-write tokens, so those land in fresh input and cost runs a little low; a reseller’s own margin is not included either.',
  };
  if (!fs.existsSync(file)) return emptyResult(source, capabilities, [{ type: 'missing-dir', message: `OpenCode database not found at ${file}` }]);
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) return emptyResult(source, capabilities, [{ type: 'no-sqlite', message: 'node:sqlite is unavailable (needs Node 22.5+). Cannot read the OpenCode database.' }]);

  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); }
  catch (err) { return emptyResult(source, capabilities, [{ type: 'read-failed', message: `Could not open OpenCode database: ${err.message}` }]); }

  const warnings = [];
  let sessions = [];
  try {
    const sessionRows = db.prepare('SELECT * FROM session ORDER BY time_updated DESC').all();
    const messageRows = db.prepare('SELECT id, session_id, time_created, data FROM message ORDER BY time_created ASC').all();
    const partRows = db.prepare('SELECT message_id, session_id, data FROM part').all();

    const msgBySession = {};
    for (const m of messageRows) (msgBySession[m.session_id] = msgBySession[m.session_id] || []).push(m);
    const partsByMessage = {};
    for (const p of partRows) (partsByMessage[p.message_id] = partsByMessage[p.message_id] || []).push(safeParse(p.data));

    // parent_id is absent on pre-2026 databases; treat those rows as top-level.
    const parentById = new Map(sessionRows.map((row) => [row.id, row.parent_id || null]));
    const collected = new Map();

    for (const s of sessionRows) {
      const messages = msgBySession[s.id] || [];
      const turns = [];
      const toolCounts = {};
      const toolEvents = [];
      let pendingPrompt = null;

      for (const m of messages) {
        const d = safeParse(m.data);
        const parts = partsByMessage[m.id] || [];
        if (d.role === 'user') {
          const text = parts.filter((p) => p.type === 'text').map((p) => p.text).filter(Boolean).join('\n').trim();
          if (text) pendingPrompt = text;
          continue;
        }
        if (d.role === 'assistant') {
          for (const p of parts) {
            const name = toolNameFromPart(p);
            if (name) {
              toolCounts[name] = (toolCounts[name] || 0) + 1;
              toolEvents.push({ name, prompt: pendingPrompt, timestamp: m.time_created });
            }
          }
          const usage = usageFromParts(parts, d);
          const model = d.modelID || d.model?.modelID || 'unknown';
          // Which upstream actually served the turn. OpenCode talks to many
          // providers, and only openrouter traffic can be reconciled against an
          // OpenRouter bill - the rest never appears on that account.
          const provider = d.providerID || d.provider?.id || null;
          const { freshInputTokens, cacheWriteTokens, recordedCost, ...tokens } = usage;
          // Trust OpenCode's own number when it has one (it prices from models.dev at
          // request time, which beats any table we ship). Back-fill from our own rates
          // only when it recorded nothing - unpriced, custom, or proxied providers.
          const estimate = recordedCost > 0 ? null : estimateCost(model, usage);
          turns.push({
            turnId: m.id,
            timestamp: new Date(m.time_created).toISOString(),
            prompt: pendingPrompt,
            model,
            provider,
            ...tokens,
            contextWindow: null,
            cost: recordedCost > 0 ? recordedCost : (estimate || 0),
            costEstimated: recordedCost > 0 || estimate !== null,
            costBackfilled: estimate !== null,
          });
        }
      }

      if (!turns.length && Object.keys(toolCounts).length === 0) continue;
      collected.set(s.id, { row: s, turns, toolCounts, toolEvents });
    }

    // Fold each helper session into its top-level ancestor.
    for (const [sessionId, data] of [...collected]) {
      const rootId = rootSessionId(sessionId, parentById);
      if (rootId === sessionId) continue;
      const root = collected.get(rootId);
      if (!root) continue; // ancestor had no turns of its own — leave the helper standalone
      for (const turn of data.turns) {
        turn.subagentSessionId = sessionId;
        turn.prompt = `↳ subagent: ${turn.prompt || data.row.title || sessionId}`;
      }
      for (const event of data.toolEvents) {
        event.prompt = `↳ subagent: ${event.prompt || data.row.title || sessionId}`;
      }
      root.turns.push(...data.turns);
      root.toolEvents.push(...data.toolEvents);
      for (const [name, count] of Object.entries(data.toolCounts)) {
        root.toolCounts[name] = (root.toolCounts[name] || 0) + count;
      }
      root.subagentCount = (root.subagentCount || 0) + 1;
      root.subagentTokens = (root.subagentTokens || 0) + data.turns.reduce((a, t) => a + t.totalTokens, 0);
      collected.delete(sessionId);
    }

    for (const { row: s, turns, toolCounts, toolEvents, subagentCount, subagentTokens } of collected.values()) {
      // A helper's turns run after the parent's opening turn, so keep the merged
      // list in wall-clock order for the per-turn drill-down.
      turns.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      const lastTurnTs = turns.length ? turns[turns.length - 1].timestamp : null;

      const firstTs = new Date(s.time_created).toISOString();
      // A helper can finish after the parent row's own time_updated.
      const rowLastTs = new Date(s.time_updated || s.time_created).toISOString();
      const lastTs = lastTurnTs && lastTurnTs > rowLastTs ? lastTurnTs : rowLastTs;
      const date = localDay(firstTs);
      const sessionModel = safeParse(s.model).id || safeParse(s.model).modelID;
      const modelCounts = {};
      for (const t of turns) if (t.model && t.model !== 'unknown') modelCounts[t.model] = (modelCounts[t.model] || 0) + 1;
      const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || sessionModel || 'unknown';
      // Title from a prompt the user actually typed, never a subagent instruction.
      const title = turns.find((t) => t.prompt && !t.subagentSessionId)?.prompt
        || (s.title && !s.title.startsWith('New session') ? s.title : null) || s.title || '(untitled OpenCode session)';
      const promptBreakdown = buildPromptBreakdown(turns, toolEvents, title);

      sessions.push({
        sessionId: s.id, filePath: file, archived: !!s.time_archived,
        title: String(title).slice(0, 240),
        project: projectFromCwd(s.directory || s.path), cwd: s.directory || null, date,
        timestamp: firstTs, updatedTimestamp: lastTs, model: primaryModel,
        turnCount: turns.length, agentMessages: turns.length,
        subagentSessions: subagentCount || 0, subagentTokens: subagentTokens || 0,
        toolCount: Object.values(toolCounts).reduce((a, n) => a + n, 0), toolCounts,
        promptCount: promptBreakdown.length, promptBreakdown, turns,
        inputTokens: turns.reduce((a, t) => a + t.inputTokens, 0),
        cachedInputTokens: turns.reduce((a, t) => a + t.cachedInputTokens, 0),
        outputTokens: turns.reduce((a, t) => a + t.outputTokens, 0),
        reasoningOutputTokens: turns.reduce((a, t) => a + t.reasoningOutputTokens, 0),
        totalTokens: turns.reduce((a, t) => a + t.totalTokens, 0),
        cost: turns.reduce((a, t) => a + (t.cost || 0), 0),
        pricedTokens: turns.filter((t) => t.costEstimated).reduce((a, t) => a + t.totalTokens, 0),
        unpricedTokens: turns.filter((t) => !t.costEstimated).reduce((a, t) => a + t.totalTokens, 0),
        backfilledCost: turns.filter((t) => t.costBackfilled).reduce((a, t) => a + (t.cost || 0), 0),
        contextWindow: null, peakInputTokens: turns.reduce((mx, t) => Math.max(mx, t.inputTokens || 0), 0),
        peakTurnTokens: turns.reduce((mx, t) => Math.max(mx, t.totalTokens || 0), 0), rateLimit: null,
      });
    }
  } catch (err) {
    warnings.push({ type: 'query-failed', message: `OpenCode database query failed: ${err.message}` });
  } finally {
    try { db.close(); } catch { /* */ }
  }

  const backfilled = sessions.reduce((a, s) => a + (s.backfilledCost || 0), 0);
  const unpriced = sessions.reduce((a, s) => a + (s.unpricedTokens || 0), 0);
  if (backfilled > 0) {
    warnings.push({ type: 'cost-backfilled', message: `OpenCode recorded $0 for some turns (providers with no models.dev pricing); about $${backfilled.toFixed(2)} of the cost shown is estimated here from published list rates.` });
  }
  if (unpriced > 0) {
    warnings.push({ type: 'cost-unpriced', message: `${unpriced.toLocaleString()} tokens ran on models with no rate on record — they are excluded from the cost total.` });
  }

  if (!sessions.length) return emptyResult(source, capabilities, warnings.length ? warnings : [{ type: 'no-sessions', message: 'No OpenCode sessions found yet. Use OpenCode and refresh.' }]);
  return buildResult(sessions, source, capabilities, warnings);
}

// On-demand per-turn content: assistant text parts + tool parts (input/output),
// keyed by message id (the turnId the dashboard already uses for OpenCode turns).
async function content(session, options = {}) {
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) return { items: [], supported: false };
  let db;
  try { db = new DatabaseSync(dbPath(options), { readOnly: true }); } catch { return { items: [] }; }
  const items = [];
  try {
    const messages = db.prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC').all(session.sessionId);
    const partStmt = db.prepare('SELECT data FROM part WHERE message_id = ?');
    for (const m of messages) {
      const d = safeParse(m.data);
      if (d.role !== 'assistant') continue;
      const parts = partStmt.all(m.id).map((r) => safeParse(r.data));
      const output = parts.filter((p) => p.type === 'text').map((p) => p.text).filter(Boolean).join('\n').trim();
      const tools = parts.filter((p) => toolNameFromPart(p)).map((p) => {
        const st = p.state || {};
        const out = st.output != null ? st.output : p.output;
        return {
          name: toolNameFromPart(p),
          input: clip(JSON.stringify(st.input || p.input || {}, null, 2), 4000),
          result: clip(typeof out === 'string' ? out : JSON.stringify(out || ''), 4000),
        };
      });
      items.push({ turnId: m.id, timestamp: new Date(m.time_created).toISOString(), output: clip(output), tools });
    }
  } catch { /* return what we have */ } finally { try { db.close(); } catch { /* */ } }
  return { items };
}

module.exports = { id, label, mark, accent, capabilities, home, detect, parse, content, _test: { usageFromParts, getPricing, estimateCost } };
