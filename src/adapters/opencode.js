// OpenCode adapter — reads the SQLite store at ~/.local/share/opencode/opencode.db
// (session/message/part tables; assistant messages carry tokens + cost).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { expandHome, projectFromCwd } = require('./shared');
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

function safeParse(json) {
  try { return JSON.parse(json); } catch { return {}; }
}

function toolNameFromPart(d) {
  if (!d) return null;
  const t = String(d.type || '');
  if (t === 'tool' || t.includes('tool')) {
    return d.tool || d.name || d.toolName || (d.toolInvocation && d.toolInvocation.toolName) || 'tool';
  }
  return null;
}

async function parse(options = {}) {
  const file = dbPath(options);
  const source = { id, label, mark, accent, home: file };
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
          const tk = d.tokens || {};
          const cache = tk.cache || {};
          const input = (tk.input || 0) + (cache.read || 0) + (cache.write || 0);
          const reasoning = tk.reasoning || 0;
          const output = (tk.output || 0) + reasoning;
          turns.push({
            turnId: m.id,
            timestamp: new Date(m.time_created).toISOString(),
            prompt: pendingPrompt,
            model: d.modelID || d.model?.modelID || 'unknown',
            inputTokens: input,
            cachedInputTokens: cache.read || 0,
            outputTokens: output,
            reasoningOutputTokens: reasoning,
            totalTokens: input + output,
            contextWindow: null,
            cost: d.cost || 0,
          });
        }
      }

      if (!turns.length && Object.keys(toolCounts).length === 0) continue;

      const firstTs = new Date(s.time_created).toISOString();
      const lastTs = new Date(s.time_updated || s.time_created).toISOString();
      const date = firstTs.split('T')[0];
      const sessionModel = safeParse(s.model).id || safeParse(s.model).modelID;
      const modelCounts = {};
      for (const t of turns) if (t.model && t.model !== 'unknown') modelCounts[t.model] = (modelCounts[t.model] || 0) + 1;
      const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || sessionModel || 'unknown';
      const title = turns.find((t) => t.prompt)?.prompt || (s.title && !s.title.startsWith('New session') ? s.title : null) || s.title || '(untitled OpenCode session)';
      const promptBreakdown = buildPromptBreakdown(turns, toolEvents, title);

      sessions.push({
        sessionId: s.id, filePath: file, archived: !!s.time_archived,
        title: String(title).slice(0, 240),
        project: projectFromCwd(s.directory || s.path), cwd: s.directory || null, date,
        timestamp: firstTs, updatedTimestamp: lastTs, model: primaryModel,
        turnCount: turns.length, agentMessages: turns.length,
        toolCount: Object.values(toolCounts).reduce((a, n) => a + n, 0), toolCounts,
        promptCount: promptBreakdown.length, promptBreakdown, turns,
        inputTokens: turns.reduce((a, t) => a + t.inputTokens, 0),
        cachedInputTokens: turns.reduce((a, t) => a + t.cachedInputTokens, 0),
        outputTokens: turns.reduce((a, t) => a + t.outputTokens, 0),
        reasoningOutputTokens: turns.reduce((a, t) => a + t.reasoningOutputTokens, 0),
        totalTokens: turns.reduce((a, t) => a + t.totalTokens, 0),
        cost: turns.reduce((a, t) => a + (t.cost || 0), 0),
        contextWindow: null, peakInputTokens: turns.reduce((mx, t) => Math.max(mx, t.inputTokens || 0), 0),
        peakTurnTokens: turns.reduce((mx, t) => Math.max(mx, t.totalTokens || 0), 0), rateLimit: null,
      });
    }
  } catch (err) {
    warnings.push({ type: 'query-failed', message: `OpenCode database query failed: ${err.message}` });
  } finally {
    try { db.close(); } catch { /* */ }
  }

  if (!sessions.length) return emptyResult(source, capabilities, warnings.length ? warnings : [{ type: 'no-sessions', message: 'No OpenCode sessions found yet. Use OpenCode and refresh.' }]);
  return buildResult(sessions, source, capabilities, warnings);
}

module.exports = { id, label, mark, accent, capabilities, home, detect, parse };
