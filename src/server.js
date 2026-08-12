const express = require('express');
const path = require('path');
const registry = require('./adapters');
const { buildResult } = require('./adapters/aggregate');

const RANGE_DAYS = { day: 0, week: 6, month: 29 };

function scopeToRange(full, range) {
  if (!range || range === 'all' || !(range in RANGE_DAYS)) return full;
  const start = new Date();
  start.setDate(start.getDate() - RANGE_DAYS[range]);
  const startStr = start.toISOString().slice(0, 10);
  const filtered = full.sessions.filter((s) => s.date && s.date >= startStr);
  if (filtered.length === full.sessions.length) return full;
  return buildResult(filtered, full.source, full.capabilities, full.warnings);
}

function createServer(options = {}) {
  const app = express();
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
