// Qwen Code adapter — reads ~/.qwen/projects/**/chats/*.jsonl
// (Claude-style transcript lines carrying Gemini-style usageMetadata).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { expandHome, parseJSONLFile, walkJSONL, textFromContent, projectFromCwd, clip, localDay } = require('./shared');
const { buildResult, emptyResult, buildPromptBreakdown } = require('./aggregate');

const id = 'qwen';
const label = 'Qwen Code';
const mark = 'QC';
const accent = '#7c6bd6';
const capabilities = { cost: false, reasoning: true, rateLimit: false, cache: true, tools: true, contextWindow: true };

function home(options = {}) {
  return expandHome(options.home || process.env.QWEN_HOME) || path.join(os.homedir(), '.qwen');
}
function detect(options = {}) {
  return fs.existsSync(path.join(home(options), 'projects'));
}

function partsText(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p === 'string' ? p : p.text || '')).filter(Boolean).join('\n');
}
function isHumanPrompt(text) {
  if (!text) return false;
  const v = String(text).trim();
  if (!v) return false;
  if (v.startsWith('<environment') || v.startsWith('This is the Qwen Code') || v.startsWith('You are')) return false;
  return true;
}

function extractSession(entries, filePath) {
  let model = 'unknown';
  let cwd = null;
  let pendingPrompt = null;
  let contextWindow = null;
  const turns = [];
  const toolCounts = {};
  const toolEvents = [];

  for (const entry of entries) {
    if (entry.cwd && !cwd) cwd = entry.cwd;
    if (entry.contextWindowSize) contextWindow = entry.contextWindowSize;
    const msg = entry.message || {};
    if (entry.type === 'user' || msg.role === 'user') {
      const text = partsText(msg.parts != null ? msg.parts : msg.content) || textFromContent(msg.content) || entry.text;
      if (isHumanPrompt(text)) pendingPrompt = text;
    }
    // Tool calls appear as functionCall parts on assistant/model messages.
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    for (const p of parts) {
      const fc = p.functionCall || p.toolCall;
      if (fc && fc.name) {
        toolCounts[fc.name] = (toolCounts[fc.name] || 0) + 1;
        toolEvents.push({ name: fc.name, prompt: pendingPrompt, timestamp: entry.timestamp });
      }
    }
    const um = entry.usageMetadata || msg.usageMetadata;
    if (um && (um.totalTokenCount || um.promptTokenCount || um.candidatesTokenCount)) {
      const m = entry.model || msg.model || model;
      model = m || model;
      const input = um.promptTokenCount || 0;
      const cached = um.cachedContentTokenCount || 0;
      const reasoning = um.thoughtsTokenCount || 0;
      const output = (um.candidatesTokenCount || 0) + reasoning; // visible + thoughts
      const total = um.totalTokenCount || input + output;
      turns.push({
        turnId: entry.uuid || `turn-${turns.length + 1}`,
        timestamp: entry.timestamp,
        prompt: pendingPrompt,
        model: m,
        inputTokens: input,
        cachedInputTokens: cached,
        outputTokens: output,
        reasoningOutputTokens: reasoning,
        totalTokens: total,
        contextWindow: entry.contextWindowSize || contextWindow || null,
      });
    }
  }

  if (!turns.length && Object.keys(toolCounts).length === 0) return null;
  const sessionId = entries.find((e) => e.sessionId)?.sessionId || path.basename(filePath, '.jsonl');
  const firstTs = entries.find((e) => e.timestamp)?.timestamp || null;
  const lastTs = entries.slice().reverse().find((e) => e.timestamp)?.timestamp || firstTs;
  const date = firstTs ? localDay(firstTs) : 'unknown';
  const project = projectFromCwd(cwd);
  const modelCounts = {};
  for (const t of turns) if (t.model) modelCounts[t.model] = (modelCounts[t.model] || 0) + 1;
  const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || model;
  const title = turns.find((t) => isHumanPrompt(t.prompt))?.prompt
    || entries.find((e) => isHumanPrompt(partsText(e.message?.parts) || e.text))?.text
    || '(untitled Qwen session)';
  const promptBreakdown = buildPromptBreakdown(turns, toolEvents, title);
  const peakInputTokens = turns.reduce((mx, t) => Math.max(mx, t.inputTokens || 0), 0);

  return {
    sessionId, filePath, archived: false,
    title: String(title).slice(0, 240), project, cwd, date,
    timestamp: firstTs, updatedTimestamp: lastTs, model: primaryModel,
    turnCount: turns.length, agentMessages: turns.length,
    toolCount: Object.values(toolCounts).reduce((s, n) => s + n, 0), toolCounts,
    promptCount: promptBreakdown.length, promptBreakdown, turns,
    inputTokens: turns.reduce((s, t) => s + t.inputTokens, 0),
    cachedInputTokens: turns.reduce((s, t) => s + t.cachedInputTokens, 0),
    outputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
    reasoningOutputTokens: turns.reduce((s, t) => s + t.reasoningOutputTokens, 0),
    totalTokens: turns.reduce((s, t) => s + t.totalTokens, 0),
    contextWindow, peakInputTokens, peakTurnTokens: turns.reduce((mx, t) => Math.max(mx, t.totalTokens || 0), 0),
    rateLimit: null,
  };
}

async function parse(options = {}) {
  const h = home(options);
  const source = { id, label, mark, accent, home: h };
  const projectsDir = path.join(h, 'projects');
  if (!fs.existsSync(projectsDir)) return emptyResult(source, capabilities, [{ type: 'missing-dir', message: `Qwen Code data not found at ${projectsDir}` }]);
  const files = walkJSONL(projectsDir);
  if (!files.length) return emptyResult(source, capabilities, [{ type: 'no-sessions', message: 'No Qwen Code chat JSONL files found.' }]);

  const warnings = [];
  const sessions = [];
  for (const filePath of files) {
    let entries;
    try { entries = await parseJSONLFile(filePath); } catch { continue; }
    if (!entries.length) continue;
    const session = extractSession(entries, filePath);
    if (session) sessions.push(session);
  }
  if (!sessions.length) return emptyResult(source, capabilities, [{ type: 'no-usage', message: 'No Qwen Code sessions with token usage found.' }]);
  return buildResult(sessions, source, capabilities, warnings);
}

// On-demand per-turn content: model text + functionCall parts (with responses).
async function content(session, options = {}) {
  let entries;
  try { entries = await parseJSONLFile(session.filePath); } catch { return { items: [] }; }
  const items = [];
  for (const e of entries) {
    const msg = e.message || {};
    const um = e.usageMetadata || msg.usageMetadata;
    if (!um || !(um.totalTokenCount || um.promptTokenCount || um.candidatesTokenCount)) continue;
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const output = parts.filter((p) => p && typeof p === 'object' && p.text).map((p) => p.text).join('\n').trim()
      || (typeof msg.content === 'string' ? msg.content : '');
    const responses = {};
    for (const p of parts) if (p && p.functionResponse) responses[p.functionResponse.name] = clip(JSON.stringify(p.functionResponse.response || ''), 4000);
    const tools = parts.filter((p) => p && p.functionCall).map((p) => ({
      name: p.functionCall.name, input: clip(JSON.stringify(p.functionCall.args || {}, null, 2), 4000), result: responses[p.functionCall.name] || null,
    }));
    items.push({ turnId: e.uuid || null, timestamp: e.timestamp || null, output: clip(output), tools });
  }
  return { items };
}

module.exports = { id, label, mark, accent, capabilities, home, detect, parse, content };
