const express = require('express');
const path = require('path');
const registry = require('./adapters');
const openrouter = require('./openrouter');
const { buildResult, buildPromptBreakdown } = require('./adapters/aggregate');
const { localDay } = require('./adapters/shared');

const RANGE_DAYS = { day: 0, week: 6, month: 29 };

// Recompute a session's aggregate fields from only the turns that fall in range —
// a multi-day session can't just be included/excluded wholesale by its start date.
function rescopeSession(session, turns) {
  const sum = (key) => turns.reduce((t, x) => t + (x[key] || 0), 0);
  const firstTimestamp = turns[0]?.timestamp || session.timestamp;
  const promptBreakdown = buildPromptBreakdown(turns, [], session.title);
  return {
    ...session,
    turns,
    turnCount: turns.length,
    timestamp: firstTimestamp,
    date: firstTimestamp ? localDay(firstTimestamp) : session.date,
    updatedTimestamp: turns[turns.length - 1]?.timestamp || session.updatedTimestamp,
    inputTokens: sum('inputTokens'),
    cachedInputTokens: sum('cachedInputTokens'),
    outputTokens: sum('outputTokens'),
    reasoningOutputTokens: sum('reasoningOutputTokens'),
    totalTokens: sum('totalTokens'),
    cost: sum('cost'),
    pricedTokens: turns.filter((turn) => turn.costEstimated !== false).reduce((t, turn) => t + (turn.totalTokens || 0), 0),
    unpricedTokens: turns.filter((turn) => turn.costEstimated === false).reduce((t, turn) => t + (turn.totalTokens || 0), 0),
    backfilledCost: turns.filter((turn) => turn.costBackfilled).reduce((t, turn) => t + (turn.cost || 0), 0),
    promptCount: promptBreakdown.length,
    promptBreakdown,
    peakInputTokens: turns.reduce((m, t) => Math.max(m, t.inputTokens || 0), 0),
    peakTurnTokens: turns.reduce((m, t) => Math.max(m, t.totalTokens || 0), 0),
  };
}

function scopeToRange(full, range) {
  if (!range || range === 'all' || !(range in RANGE_DAYS)) return full;
  const start = new Date();
  start.setDate(start.getDate() - RANGE_DAYS[range]);
  const startStr = localDay(start);

  const scoped = [];
  for (const session of full.sessions) {
    const turns = (session.turns || []).filter((t) => (t.timestamp ? localDay(t.timestamp) : session.date) >= startStr);
    if (turns.length === 0) continue;
    scoped.push(turns.length === session.turns.length ? session : rescopeSession(session, turns));
  }
  return buildResult(scoped, full.source, full.capabilities, full.warnings);
}

// The dashboard is a local page, so any request that changes server state must
// prove it came from that page rather than from some other site the browser has
// open. A same-origin (or origin-less) request plus a header no cross-site form
// can set is enough here; the port is loopback-only by default.
function localOnly(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).hostname; } catch { host = null; }
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
      return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    }
  }
  if (req.get('x-metrascope') !== '1') return res.status(403).json({ error: 'Missing dashboard request header.' });
  return next();
}

function createServer(options = {}) {
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  const cache = {}; // sourceId -> parsed result (always unfiltered / "all")

  function friendlyError(err) {
    if (err.code === 'ENOENT') return { error: 'Agent data directory not found.', code: err.code };
    if (err.code === 'EPERM' || err.code === 'EACCES') return { error: 'Permission denied reading agent data.', code: err.code };
    return { error: err.message || String(err) };
  }

  function resolveSourceId(req) {
    const requested = req.query.source;
    if (requested && registry.get(requested)) return requested;
    return registry.defaultSourceId();
  }

  async function readSource(sourceId) {
    const adapter = registry.get(sourceId);
    // Back-compat: a legacy --codex-home still flows to the codex adapter.
    const opts = sourceId === 'codex' ? { codexHome: options.codexHome } : {};
    return adapter.parse(opts);
  }

  // List every known agent and whether its data is present on this machine.
  app.get('/api/sources', (req, res) => {
    res.json({ sources: registry.list(), default: registry.defaultSourceId() });
  });

  app.get('/api/data', async (req, res) => {
    const sourceId = resolveSourceId(req);
    try {
      if (!cache[sourceId]) cache[sourceId] = await readSource(sourceId);
      res.json(scopeToRange(cache[sourceId], req.query.range));
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  app.get('/api/refresh', async (req, res) => {
    const sourceId = resolveSourceId(req);
    try {
      cache[sourceId] = await readSource(sourceId);
      res.json({ ok: true, source: sourceId, sessions: cache[sourceId].sessions.length });
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  // Real OpenRouter spend for the current range, to sit beside the local
  // estimate. Off until a key is configured — typed into the dashboard, saved
  // by the user, or in OPENROUTER_API_KEY. The key is resolved inside the
  // module and never travels back to the browser.
  const spendCache = new Map(); // range -> { at, payload }
  const SPEND_TTL_MS = 5 * 60 * 1000;

  // Key management for the dashboard's OpenRouter panel. The key itself is
  // write-only across this boundary: it goes in, and only a masked label and an
  // origin ever come back out.
  app.get('/api/openrouter/key', (req, res) => res.json(openrouter.status()));

  app.post('/api/openrouter/key', localOnly, async (req, res) => {
    const { key, remember } = req.body || {};
    const result = await openrouter.setKey(key, { remember: Boolean(remember) });
    spendCache.clear();
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.delete('/api/openrouter/key', localOnly, (req, res) => {
    const result = openrouter.clearKey();
    spendCache.clear();
    res.json(result);
  });

  app.get('/api/openrouter', async (req, res) => {
    const range = ['day', 'week', 'month', 'all'].includes(req.query.range) ? req.query.range : 'all';
    if (!openrouter.enabled()) return res.json({ enabled: false });
    const hit = spendCache.get(range);
    if (hit && Date.now() - hit.at < SPEND_TTL_MS && !req.query.force) return res.json(hit.payload);
    try {
      const payload = await openrouter.fetchSpend(range);
      spendCache.set(range, { at: Date.now(), payload });
      res.json(payload);
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  // Per-turn message content (prompt/output/tools), read on demand for one session.
  app.get('/api/content', async (req, res) => {
    const sourceId = resolveSourceId(req);
    const sessionId = req.query.session;
    try {
      if (!cache[sourceId]) cache[sourceId] = await readSource(sourceId);
      const session = (cache[sourceId].sessions || []).find((s) => s.sessionId === sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found.' });
      const adapter = registry.get(sourceId);
      if (typeof adapter.content !== 'function') return res.json({ supported: false, items: [] });
      const opts = sourceId === 'codex' ? { codexHome: options.codexHome } : {};
      const data = await adapter.content(session, opts);
      res.json({ supported: data.supported !== false, items: data.items || [], system: data.system || null, promptTemplate: data.promptTemplate || null });
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  // Local dashboard: never let the browser serve a stale build of the UI.
  app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  }));
  return app;
}

module.exports = { createServer };
