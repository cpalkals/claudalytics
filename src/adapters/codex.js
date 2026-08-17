// Codex CLI adapter — reads ~/.codex session JSONL with token_count events.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { expandHome, parseJSONLFile, readJSONLMap, walkJSONL, textFromContent, projectFromCwd, clip, localDay } = require('./shared');
const { buildResult, emptyResult, buildPromptBreakdown } = require('./aggregate');

const id = 'codex';
const label = 'Codex';
const mark = 'CX';
const accent = '#d4a44a';
const capabilities = { cost: true, reasoning: true, rateLimit: true, cache: true, tools: true, contextWindow: true };

// OpenAI API per-token pricing (estimate; Codex CLI is usually billed against a
// ChatGPT plan, not metered API, so this is a rate estimate, not an invoice).
// Cached input is consistently ~10% of the fresh-input rate across the GPT-5.x
// family; OpenAI doesn't bill a separate "cache write" the way Anthropic does.
const MODEL_PRICING = {
  'gpt-5.2': { input: 0.875 / 1e6, cachedInput: 0.0875 / 1e6, output: 7.00 / 1e6 },
  'gpt-5.3-codex': { input: 1.75 / 1e6, cachedInput: 0.175 / 1e6, output: 14.00 / 1e6 },
  'gpt-5.4-nano': { input: 0.20 / 1e6, cachedInput: 0.02 / 1e6, output: 1.25 / 1e6 },
  'gpt-5.4-mini': { input: 0.75 / 1e6, cachedInput: 0.075 / 1e6, output: 4.50 / 1e6 },
  'gpt-5.4': { input: 2.50 / 1e6, cachedInput: 0.25 / 1e6, output: 15.00 / 1e6 },
  'gpt-5.5-pro': { input: 30.00 / 1e6, cachedInput: 30.00 / 1e6, output: 180.00 / 1e6 },
  'gpt-5.5': { input: 5.00 / 1e6, cachedInput: 0.50 / 1e6, output: 30.00 / 1e6 },
  'gpt-5.6-luna': { input: 0.20 / 1e6, cachedInput: 0.02 / 1e6, output: 1.20 / 1e6 },
  'gpt-5.6-terra': { input: 2.00 / 1e6, cachedInput: 0.20 / 1e6, output: 12.00 / 1e6 },
  'gpt-5.6-sol': { input: 5.00 / 1e6, cachedInput: 0.50 / 1e6, output: 30.00 / 1e6 },
  'gpt-5.6': { input: 5.00 / 1e6, cachedInput: 0.50 / 1e6, output: 30.00 / 1e6 },
};
// Longest key first, so e.g. "gpt-5.4-mini" matches before the "gpt-5.4" fallback.
const PRICING_KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
const DEFAULT_PRICING = MODEL_PRICING['gpt-5.5'];
function getPricing(model) {
  if (!model) return DEFAULT_PRICING;
  const m = model.toLowerCase();
  const key = PRICING_KEYS.find((k) => m.includes(k));
  return key ? MODEL_PRICING[key] : DEFAULT_PRICING;
}

function home(options = {}) {
  return expandHome(options.home || options.codexHome || process.env.CODEX_HOME) || path.join(os.homedir(), '.codex');
}

function detect(options = {}) {
  const h = home(options);
  return fs.existsSync(path.join(h, 'sessions')) || fs.existsSync(path.join(h, 'archived_sessions'));
}

function isHumanPrompt(text) {
  if (!text) return false;
  const value = String(text).trim();
  if (!value) return false;
  if (value.startsWith('<environment_context>')) return false;
  if (value.startsWith('The following is the Codex agent history')) return false;
  if (value.startsWith('Continue the same review conversation')) return false;
  if (value.startsWith('You are reviewing an already-completed Codex turn')) return false;
  return true;
}

function extractSessionId(filePath, metaId) {
  if (metaId) return metaId;
  const base = path.basename(filePath, '.jsonl');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  return match ? match[1] : base;
}

function tokenUsageFromPayload(payload) {
  if (!payload || payload.type !== 'token_count') return null;
  const info = payload.info || {};
  const last = info.last_token_usage || {};
  const total = info.total_token_usage || {};
  return {
    inputTokens: last.input_tokens || 0,
    cachedInputTokens: last.cached_input_tokens || 0,
    outputTokens: last.output_tokens || 0,
    reasoningOutputTokens: last.reasoning_output_tokens || 0,
    totalTokens: last.total_tokens || 0,
    cumulativeTokens: total.total_tokens || 0,
    cumulativeInputTokens: total.input_tokens || 0,
    cumulativeCachedInputTokens: total.cached_input_tokens || 0,
    cumulativeOutputTokens: total.output_tokens || 0,
    cumulativeReasoningOutputTokens: total.reasoning_output_tokens || 0,
    contextWindow: info.model_context_window || null,
    rateLimits: payload.rate_limits || null,
  };
}

function latestRateLimit(rateLimits, previous) {
  if (!rateLimits) return previous || null;
  return {
    planType: rateLimits.plan_type || previous?.planType || null,
    limitId: rateLimits.limit_id || previous?.limitId || null,
    primaryUsedPercent: rateLimits.primary?.used_percent ?? previous?.primaryUsedPercent ?? null,
    primaryWindowMinutes: rateLimits.primary?.window_minutes ?? previous?.primaryWindowMinutes ?? null,
    primaryResetsAt: rateLimits.primary?.resets_at ?? previous?.primaryResetsAt ?? null,
    secondaryUsedPercent: rateLimits.secondary?.used_percent ?? previous?.secondaryUsedPercent ?? null,
    secondaryWindowMinutes: rateLimits.secondary?.window_minutes ?? previous?.secondaryWindowMinutes ?? null,
    secondaryResetsAt: rateLimits.secondary?.resets_at ?? previous?.secondaryResetsAt ?? null,
    reachedType: rateLimits.rate_limit_reached_type || previous?.reachedType || null,
  };
}

function sumTurns(turns, key) {
  return turns.reduce((t, x) => t + (x[key] || 0), 0);
}

function extractSession(entries, filePath, titleMap, promptMap) {
  let meta = {};
  let model = 'unknown';
  let currentUserPrompt = null;
  let currentTurnId = null;
  let latestRate = null;
  const turns = [];
  const toolCounts = {};
  const toolEvents = [];
  let agentMessages = 0;

  for (const entry of entries) {
    const payload = entry.payload || {};
    if (entry.type === 'session_meta') { meta = payload; model = payload.model || model; continue; }
    if (entry.type === 'turn_context') { currentTurnId = payload.turn_id || currentTurnId; model = payload.model || model; continue; }
    if (payload.type === 'user_message') { if (isHumanPrompt(payload.message)) currentUserPrompt = payload.message; currentTurnId = payload.turn_id || currentTurnId; continue; }
    if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const text = textFromContent(payload.content);
      if (isHumanPrompt(text)) currentUserPrompt = text;
      continue;
    }
    if (entry.type === 'response_item' && payload.type === 'function_call') {
      const name = payload.name || 'tool';
      toolCounts[name] = (toolCounts[name] || 0) + 1;
      toolEvents.push({ name, timestamp: entry.timestamp, prompt: currentUserPrompt || null, turnId: currentTurnId || null });
      continue;
    }
    if (payload.type === 'agent_message') { agentMessages += 1; continue; }
    const usage = tokenUsageFromPayload(payload);
    if (usage) {
      latestRate = latestRateLimit(usage.rateLimits, latestRate);
      const pricing = getPricing(model);
      const freshInput = Math.max(0, (usage.inputTokens || 0) - (usage.cachedInputTokens || 0));
      const cost = freshInput * pricing.input + (usage.cachedInputTokens || 0) * pricing.cachedInput + (usage.outputTokens || 0) * pricing.output;
      turns.push({ turnId: payload.turn_id || currentTurnId || `turn-${turns.length + 1}`, timestamp: entry.timestamp, prompt: currentUserPrompt || null, model, ...usage, cost });
    }
  }

  const sessionId = extractSessionId(filePath, meta.id);
  if (turns.length === 0 && agentMessages === 0 && Object.keys(toolCounts).length === 0) return null;

  const lastTurn = turns[turns.length - 1] || {};
  const peakInputTokens = turns.reduce((max, t) => Math.max(max, t.inputTokens || 0), 0);
  const peakTurnTokens = turns.reduce((max, t) => Math.max(max, t.totalTokens || 0), 0);
  const firstTimestamp = meta.timestamp || entries.find((e) => e.timestamp)?.timestamp || null;
  const updatedTimestamp = entries.slice().reverse().find((e) => e.timestamp)?.timestamp || firstTimestamp;
  const date = firstTimestamp ? localDay(firstTimestamp) : 'unknown';
  const titleCandidate = titleMap[sessionId];
  const historyPrompt = promptMap[sessionId];
  const title = (isHumanPrompt(titleCandidate) && titleCandidate)
    || (isHumanPrompt(historyPrompt) && historyPrompt)
    || (isHumanPrompt(currentUserPrompt) && currentUserPrompt)
    || '(untitled Codex session)';
  const project = projectFromCwd(meta.cwd || entries.find((e) => e.payload?.cwd)?.payload.cwd);
  const promptBreakdown = buildPromptBreakdown(turns, toolEvents, title);

  return {
    sessionId, filePath,
    archived: filePath.includes(`${path.sep}archived_sessions${path.sep}`),
    title: String(title).slice(0, 240), project, cwd: meta.cwd || null, date,
    timestamp: firstTimestamp, updatedTimestamp, model,
    turnCount: turns.length, agentMessages,
    toolCount: Object.values(toolCounts).reduce((s, n) => s + n, 0), toolCounts,
    promptCount: promptBreakdown.length, promptBreakdown, turns,
    inputTokens: lastTurn.cumulativeInputTokens || sumTurns(turns, 'inputTokens'),
    cachedInputTokens: lastTurn.cumulativeCachedInputTokens || sumTurns(turns, 'cachedInputTokens'),
    outputTokens: lastTurn.cumulativeOutputTokens || sumTurns(turns, 'outputTokens'),
    reasoningOutputTokens: lastTurn.cumulativeReasoningOutputTokens || sumTurns(turns, 'reasoningOutputTokens'),
    totalTokens: lastTurn.cumulativeTokens || sumTurns(turns, 'totalTokens'),
    cost: sumTurns(turns, 'cost'),
    contextWindow: lastTurn.contextWindow || null, peakInputTokens, peakTurnTokens, rateLimit: latestRate,
  };
}

async function parse(options = {}) {
  const h = home(options);
  const source = { id, label, mark, accent, home: h };
  if (!fs.existsSync(h)) return emptyResult(source, capabilities, [{ type: 'missing-dir', message: `Codex home not found at ${h}` }]);

  const titleMap = await readJSONLMap(path.join(h, 'session_index.jsonl'), (e) => e.id, (e) => e.thread_name || e.id);
  const promptMap = await readJSONLMap(path.join(h, 'history.jsonl'), (e) => e.session_id, (e) => e.text);
  const files = [...walkJSONL(path.join(h, 'sessions')), ...walkJSONL(path.join(h, 'archived_sessions'))];
  if (files.length === 0) return emptyResult(source, capabilities, [{ type: 'no-sessions', message: 'No Codex session JSONL files found.' }]);

  const warnings = [];
  const sessions = [];
  for (const filePath of files) {
    let entries;
    try { entries = await parseJSONLFile(filePath); }
    catch (err) { warnings.push({ type: 'read-failed', message: `Could not read ${filePath}: ${err.message}` }); continue; }
    const session = extractSession(entries, filePath, titleMap, promptMap);
    if (session) sessions.push(session);
  }
  return buildResult(sessions, source, capabilities, warnings);
}

// On-demand per-turn content: agent_message text + function calls/outputs, keyed
// by turn_id (the same id the token turns carry, so the UI can match them up).
async function content(session, options = {}) {
  let entries;
  try { entries = await parseJSONLFile(session.filePath); } catch { return { items: [] }; }
  // Codex records its system prompt in session_meta.base_instructions, plus the
  // initial <environment_context> / <permissions instructions> input blocks.
  let system = null;
  const meta = entries.find((e) => e.type === 'session_meta')?.payload || {};
  const bi = meta.base_instructions;
  const biText = typeof bi === 'string' ? bi : (bi && bi.text) || '';
  const context = [];
  for (const e of entries) {
    const p = e.payload || {};
    if (p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
      const t = textFromContent(p.content);
      if (t.startsWith('<')) context.push(t); else break;
    }
  }
  if (biText || context.length) system = clip([biText, ...context].filter(Boolean).join('\n\n'), 60000);
  const byTurn = new Map();
  const callIndex = {};
  let currentTurnId = null;
  let lastTs = null;
  const ensure = (tid) => {
    const key = tid || `turn-${byTurn.size + 1}`;
    if (!byTurn.has(key)) byTurn.set(key, { turnId: key, timestamp: lastTs, output: '', tools: [] });
    return byTurn.get(key);
  };
  for (const entry of entries) {
    if (entry.timestamp) lastTs = entry.timestamp;
    const payload = entry.payload || {};
    if (entry.type === 'turn_context') currentTurnId = payload.turn_id || currentTurnId;
    if (payload.type === 'user_message') currentTurnId = payload.turn_id || currentTurnId;
    const tid = payload.turn_id || currentTurnId;
    if (payload.type === 'agent_message') {
      const t = ensure(tid); const txt = textFromContent(payload.message || payload.content);
      t.output = t.output ? `${t.output}\n${txt}` : txt; if (entry.timestamp) t.timestamp = entry.timestamp;
    } else if (entry.type === 'response_item' && payload.type === 'function_call') {
      const tool = { name: payload.name || 'tool', input: clip(payload.arguments || '', 4000), result: null };
      ensure(tid).tools.push(tool); if (payload.call_id) callIndex[payload.call_id] = tool;
    } else if (entry.type === 'response_item' && payload.type === 'function_call_output') {
      const tool = callIndex[payload.call_id];
      if (tool) { const out = payload.output; tool.result = clip(typeof out === 'string' ? out : textFromContent(out) || JSON.stringify(out || ''), 4000); }
    }
  }
  return { system, items: [...byTurn.values()].map((t) => ({ ...t, output: clip(t.output) })) };
}

module.exports = { id, label, mark, accent, capabilities, home, detect, parse, content };
