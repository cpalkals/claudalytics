const express = require('express');
const path = require('path');

function createServer(options = {}) {
  const app = express();
  let cachedData = null;

  function friendlyError(err) {
    if (err.code === 'ENOENT') {
      return { error: 'Codex data directory not found. Try --codex-home <path>.', code: err.code };
    }
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      return { error: 'Permission denied reading Codex data.', code: err.code };
    }
    return { error: err.message || String(err) };
  }

  async function readData() {
    return require('./parser').parseAllSessions(options);
  }

  app.get('/api/data', async (req, res) => {
    try {
      if (!cachedData) cachedData = await readData();
      res.json(cachedData);
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  app.get('/api/refresh', async (req, res) => {
    try {
      delete require.cache[require.resolve('./parser')];
      cachedData = await readData();
      res.json({ ok: true, sessions: cachedData.sessions.length });
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  app.use(express.static(path.join(__dirname, 'public')));
  return app;
}

module.exports = { createServer };
