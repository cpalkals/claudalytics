// Claude Code adapter — reads ~/.claude/projects/**/*.jsonl (assistant usage blocks).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { expandHome, parseJSONLFile, clip } = require('./shared');
const { buildResult, emptyResult, buildPromptBreakdown } = require('./aggregate');

const id = 'claude';
const label = 'Claude Code';
const mark = 'CC';
const accent = '#cc785c';
const capabilities = { cost: true, reasoning: false, rateLimit: false, cache: true, tools: true, contextWindow: false, limitEvents: true };

// Claude Code logs a synthetic 429 assistant message when you hit a usage limit,
// e.g. "You've hit your session limit · resets 4:20pm (Asia/Kolkata)".
const LIMIT_RX = /hit your (?:(\w+) )?limit\s*[·.]?\s*resets\s+([0-9]{1,2}:[0-9]{2}\s*[ap]m)\s*\(([^)]+)\)/i;
function limitHitFromEntry(entry) {
  if (entry.apiErrorStatus !== 429 && entry.error !== 'rate_limit') return null;
  const content = entry.message && entry.message.content;
  const text = Array.isArray(content) ? content.map((b) => b.text || '').join(' ') : (typeof content === 'string' ? content : '');
  const m = text.match(LIMIT_RX);
  if (!m) return null;
  return {
    timestamp: entry.timestamp || null,
    kind: /session/i.test(m[1] || '') ? 'session' : 'weekly',
    reset: m[2].replace(/\s+/g, ''),
    tz: m[3],
  };
}
function summarizeLimitHits(hits) {
  const pick = (kind) => {
    const list = hits.filter((h) => h.kind === kind).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    return { count: list.length, last: list[0] || null };
  };
  return { total: hits.length, session: pick('session'), weekly: pick('weekly') };
}

// Anthropic API per-token pricing (estimate; subscription billing differs).
const MODEL_PRICING = {
  'opus-4.5': { input: 5 / 1e6, output: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.50 / 1e6 },
  'opus-4.6': { input: 5 / 1e6, output: 25 / 1e6, cacheWrite: 6.25 / 1e6, cacheRead: 0.50 / 1e6 },
  'opus-4.0': { input: 15 / 1e6, output: 75 / 1e6, cacheWrite: 18.75 / 1e6, cacheRead: 1.50 / 1e6 },
  'opus-4.1': { input: 15 / 1e6, output: 75 / 1e6, cacheWrite: 18.75 / 1e6, cacheRead: 1.50 / 1e6 },
  sonnet: { input: 3 / 1e6, output: 15 / 1e6, cacheWrite: 3.75 / 1e6, cacheRead: 0.30 / 1e6 },
  'haiku-4.5': { input: 1 / 1e6, output: 5 / 1e6, cacheWrite: 1.25 / 1e6, cacheRead: 0.10 / 1e6 },
  'haiku-3.5': { input: 0.80 / 1e6, output: 4 / 1e6, cacheWrite: 1.00 / 1e6, cacheRead: 0.08 / 1e6 },
};
const DEFAULT_PRICING = MODEL_PRICING.sonnet;
function getPricing(model) {
  if (!model) return DEFAULT_PRICING;
  const m = model.toLowerCase();
  if (m.includes('opus')) {
    if (m.includes('4-6') || m.includes('4.6')) return MODEL_PRICING['opus-4.6'];
    if (m.includes('4-5') || m.includes('4.5')) return MODEL_PRICING['opus-4.5'];
    if (m.includes('4-1') || m.includes('4.1')) return MODEL_PRICING['opus-4.1'];
    return MODEL_PRICING['opus-4.0'];
  }
  if (m.includes('sonnet')) return MODEL_PRICING.sonnet;
  if (m.includes('haiku')) return m.includes('4-5') || m.includes('4.5') ? MODEL_PRICING['haiku-4.5'] : MODEL_PRICING['haiku-3.5'];
  return DEFAULT_PRICING;
}

function home(options = {}) {
  return expandHome(options.home || process.env.CLAUDE_HOME) || path.join(os.homedir(), '.claude');
}
function detect(options = {}) {
  return fs.existsSync(path.join(home(options), 'projects'));
}

// Pair each user prompt with the assistant usage turns that follow it.
// Claude Code logs one JSONL line per content block of a response, repeating the
// same message.usage on each — so we group by message.id and count usage once.
function extractTurns(entries) {
  const turns = [];
  const byId = new Map();
  let pendingPrompt = null;
  for (const entry of entries) {
    if (entry.type === 'user' && entry.message?.role === 'user') {
      if (entry.isMeta) continue;
      const content = entry.message.content;
      if (typeof content === 'string' && (content.startsWith('<local-command') || content.startsWith('<command-name'))) continue;
      const text = typeof content === 'string'
        ? content
        : (Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() : '');
      pendingPrompt = text || null;
    }
    if (entry.type === 'assistant' && entry.message?.usage) {
      const model = entry.message.model || 'unknown';
      if (model === '<synthetic>') continue;
      const tools = [];
      if (Array.isArray(entry.message.content)) {
        for (const b of entry.message.content) if (b.type === 'tool_use' && b.name) tools.push(b.name);
      }
      const msgId = entry.message.id || entry.uuid || `turn-${turns.length + 1}`;
      // Another content block of a response we already counted — merge tools only.
      if (byId.has(msgId)) { for (const name of tools) turns[byId.get(msgId)].tools.push(name); continue; }
      const u = entry.message.usage;
      const pricing = getPricing(model);
      const inputTokens = u.input_tokens || 0;
      const cacheCreate = u.cache_creation_input_tokens || 0;
      const cacheRead = u.cache_read_input_tokens || 0;
      const outputTokens = u.output_tokens || 0;
      // Treat all input flavors (fresh + cache write + cache read) as input volume,
      // and cacheRead as the "cached" slice, to match the dashboard's token model.
      const totalInput = inputTokens + cacheCreate + cacheRead;
      const cost = inputTokens * pricing.input + cacheCreate * pricing.cacheWrite + cacheRead * pricing.cacheRead + outputTokens * pricing.output;
      byId.set(msgId, turns.length);
      turns.push({
        turnId: msgId,
        timestamp: entry.timestamp,
        prompt: pendingPrompt,
        model,
        inputTokens: totalInput,
        cachedInputTokens: cacheRead,
        outputTokens,
        reasoningOutputTokens: 0,
        totalTokens: totalInput + outputTokens,
        contextWindow: null,
        cost,
        tools,
      });
    }
  }
  return turns;
}

function modelLabel(model) {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'claude-opus';
  if (m.includes('sonnet')) return 'claude-sonnet';
  if (m.includes('haiku')) return 'claude-haiku';
  return model;
}

async function parse(options = {}) {
  const h = home(options);
  const source = { id, label, mark, accent, home: h };
  const projectsDir = path.join(h, 'projects');
  if (!fs.existsSync(projectsDir)) return emptyResult(source, capabilities, [{ type: 'missing-dir', message: `Claude Code data not found at ${projectsDir}` }]);

  // history.jsonl gives a friendlier first-prompt per session.
  const historyPath = path.join(h, 'history.jsonl');
  const historyEntries = fs.existsSync(historyPath) ? await parseJSONLFile(historyPath) : [];
  const sessionFirstPrompt = {};
  for (const e of historyEntries) {
    if (e.sessionId && e.display && !sessionFirstPrompt[e.sessionId]) {
      const d = e.display.trim();
      if (d.startsWith('/') && d.length < 30) continue;
      sessionFirstPrompt[e.sessionId] = d;
    }
  }

  const warnings = [];
  const sessions = [];
  const limitHits = [];
  let projectDirs = [];
  try { projectDirs = fs.readdirSync(projectsDir).filter((d) => { try { return fs.statSync(path.join(projectsDir, d)).isDirectory(); } catch { return false; } }); } catch { /* */ }

  for (const projectDir of projectDirs) {
    const dir = path.join(projectsDir, projectDir);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const file of files) {
      const filePath = path.join(dir, file);
      const sessionId = path.basename(file, '.jsonl');
      let entries;
      try { entries = await parseJSONLFile(filePath); } catch { continue; }
      if (!entries.length) continue;
      for (const e of entries) { const hit = limitHitFromEntry(e); if (hit) limitHits.push(hit); }
      const rawTurns = extractTurns(entries);
      if (!rawTurns.length) continue;

      // Normalize project label from the encoded dir name (cwd path with '-' separators).
      const cwd = entries.find((e) => e.cwd)?.cwd || projectDir.replace(/^-/, '/').replace(/-/g, '/');
      const project = cwd.split('/').filter(Boolean).slice(-2).join('/') || projectDir;

      const toolCounts = {};
      const toolEvents = [];
      for (const t of rawTurns) for (const name of t.tools || []) {
        toolCounts[name] = (toolCounts[name] || 0) + 1;
        toolEvents.push({ name, prompt: t.prompt, timestamp: t.timestamp });
      }

      const firstTs = entries.find((e) => e.timestamp)?.timestamp || null;
      const lastTs = entries.slice().reverse().find((e) => e.timestamp)?.timestamp || firstTs;
      const date = firstTs ? firstTs.split('T')[0] : 'unknown';
      const modelCounts = {};
      for (const t of rawTurns) modelCounts[t.model] = (modelCounts[t.model] || 0) + 1;
      const primaryModel = modelLabel(Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0]);
      const title = sessionFirstPrompt[sessionId] || rawTurns.find((t) => t.prompt)?.prompt || '(no prompt)';
      const promptBreakdown = buildPromptBreakdown(rawTurns, toolEvents, title);

      sessions.push({
        sessionId, filePath, archived: false,
        title: String(title).slice(0, 240), project, cwd, date,
        timestamp: firstTs, updatedTimestamp: lastTs, model: primaryModel,
        turnCount: rawTurns.length, agentMessages: rawTurns.length,
        toolCount: Object.values(toolCounts).reduce((s, n) => s + n, 0), toolCounts,
        promptCount: promptBreakdown.length, promptBreakdown,
        turns: rawTurns.map((t) => ({ ...t, model: modelLabel(t.model) })),
        inputTokens: rawTurns.reduce((s, t) => s + t.inputTokens, 0),
        cachedInputTokens: rawTurns.reduce((s, t) => s + t.cachedInputTokens, 0),
        outputTokens: rawTurns.reduce((s, t) => s + t.outputTokens, 0),
        reasoningOutputTokens: 0,
        totalTokens: rawTurns.reduce((s, t) => s + t.totalTokens, 0),
        cost: rawTurns.reduce((s, t) => s + (t.cost || 0), 0),
        contextWindow: null, peakInputTokens: 0, peakTurnTokens: 0, rateLimit: null,
      });
    }
  }
  if (!sessions.length) return emptyResult(source, capabilities, [{ type: 'no-sessions', message: 'No Claude Code sessions with usage found.' }]);
  const result = buildResult(sessions, source, capabilities, warnings);
  result.limitEvents = summarizeLimitHits(limitHits);
  return result;
}

// On-demand per-turn content for one session: assistant output text + tool calls
// (with their results, which Claude logs as tool_result blocks in the next user msg).
async function content(session, options = {}) {
  let entries;
  try { entries = await parseJSONLFile(session.filePath); } catch { return { items: [] }; }
  const toolResults = {};
  for (const e of entries) {
    const c = e.message && e.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        const txt = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '');
        toolResults[b.tool_use_id] = txt;
      }
    }
  }
  const items = [];
  const byId = new Map();
  for (const e of entries) {
    if (e.type !== 'assistant' || !e.message?.usage || e.message.model === '<synthetic>') continue;
    const c = Array.isArray(e.message.content) ? e.message.content : [];
    const output = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const tools = c.filter((b) => b.type === 'tool_use').map((b) => ({
      name: b.name, input: clip(JSON.stringify(b.input, null, 2), 4000), result: clip(toolResults[b.id] || '', 4000),
    }));
    const msgId = e.message.id || e.uuid || null;
    // Merge content blocks that belong to the same response (same message.id).
    if (msgId != null && byId.has(msgId)) {
      const it = items[byId.get(msgId)];
      if (output) it.output = it.output ? `${it.output}\n${output}` : output;
      it.tools.push(...tools);
      continue;
    }
    if (msgId != null) byId.set(msgId, items.length);
    items.push({ turnId: msgId, timestamp: e.timestamp || null, output, tools });
  }
  for (const it of items) it.output = clip(it.output);
  return { items };
}

module.exports = { id, label, mark, accent, capabilities, home, detect, parse, content };
