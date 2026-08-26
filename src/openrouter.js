// OpenRouter spend lookup — turns the local token estimate into a reconciliation
// against what OpenRouter actually billed.
//
// The key can come from three places, in this order of precedence:
//   1. a key typed into the dashboard this run (memory only, gone on restart)
//   2. a key the user explicitly chose to remember (0600 file under ~/.metrascope)
//   3. OPENROUTER_API_KEY in the environment
// Nothing is written to disk unless the user ticks "remember", and the key is
// never included in an API response — only the masked label OpenRouter returns.
//
// Scope caveats, surfaced in the payload so the UI can state them:
//  - Figures are per API key, so they include any non-OpenCode traffic on it.
//  - OpenRouter buckets by UTC day; this dashboard buckets by local day.
//  - Per-request reconciliation is impossible: OpenRouter's exact per-generation
//    cost needs a generation id, and OpenCode never records one.
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 8000;

function configPath() {
  return path.join(process.env.METRASCOPE_HOME || path.join(os.homedir(), '.metrascope'), 'openrouter.json');
}

// Set from the dashboard; deliberately process-local so the default path leaves
// no trace on disk.
let sessionKey = null;

function savedKey() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const key = (JSON.parse(raw).key || '').trim();
    return key || null;
  } catch { return null; }
}

function envKey() {
  const key = (process.env.OPENROUTER_API_KEY || '').trim();
  return key || null;
}

// Precedence: this run's key, then a remembered one, then the environment.
function resolveKey() {
  if (sessionKey) return { key: sessionKey, origin: 'session' };
  const saved = savedKey();
  if (saved) return { key: saved, origin: 'saved' };
  const env = envKey();
  if (env) return { key: env, origin: 'env' };
  return { key: null, origin: null };
}

function apiKey() {
  return resolveKey().key;
}

function enabled() {
  return apiKey() !== null;
}

// Never echo a key back; this is only enough to recognise which one is loaded.
function mask(key) {
  if (!key) return null;
  return key.length <= 12 ? '…' + key.slice(-4) : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function status() {
  const { key, origin } = resolveKey();
  return {
    configured: Boolean(key),
    origin,
    masked: mask(key),
    // An env-supplied key cannot be cleared from the UI - it would come straight
    // back on the next read.
    removable: origin === 'session' || origin === 'saved',
    remembered: savedKey() !== null,
    configPath: configPath(),
  };
}

// Checks the key against OpenRouter before accepting it, so a typo surfaces
// immediately rather than as an empty card later.
async function setKey(key, { remember = false } = {}) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return { ok: false, error: 'Enter an OpenRouter API key.' };
  if (!/^sk-or-/.test(trimmed)) return { ok: false, error: 'That does not look like an OpenRouter key — they start with "sk-or-".' };

  const probe = await callApi('/key', trimmed);
  if (!probe.ok) return { ok: false, error: `OpenRouter rejected the key: ${probe.error}` };

  sessionKey = trimmed;
  if (remember) {
    try {
      const file = configPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ key: trimmed }, null, 2), { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
    } catch (err) {
      return { ok: true, saved: false, status: status(), warning: `Key accepted for this session, but saving it failed: ${err.message}` };
    }
  }
  return { ok: true, saved: Boolean(remember), status: status() };
}

function clearKey() {
  sessionKey = null;
  let removed = false;
  try { fs.unlinkSync(configPath()); removed = true; } catch { /* nothing saved */ }
  return { ok: true, removed, status: status() };
}

async function callApi(endpoint, key) {
  let res;
  try {
    res = await fetch(`${BASE}${endpoint}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000}s` : err.message;
    return { ok: false, status: 0, error: `Could not reach OpenRouter (${reason}).` };
  }
  if (!res.ok) {
    const detail = res.status === 401 ? 'the key was rejected'
      : res.status === 403 ? 'this key is not allowed to read it'
      : res.status === 429 ? 'OpenRouter rate-limited the request'
      : `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: detail };
  }
  try {
    const body = await res.json();
    return { ok: true, status: res.status, data: body.data ?? body };
  } catch (err) {
    return { ok: false, status: res.status, error: `OpenRouter returned unreadable JSON (${err.message}).` };
  }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Last 30 completed UTC days, one row per day per model. Management key only.
function normalizeActivity(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    date: String(row.date || '').slice(0, 10),
    model: row.model || row.model_permaslug || 'unknown',
    provider: row.provider_name || null,
    requests: num(row.requests),
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    reasoningTokens: num(row.reasoning_tokens),
    cost: num(row.usage) + num(row.byok_usage_inference),
  })).filter((row) => row.date);
}

// UTC day strings for the window a dashboard range covers. `all` means "no
// filter" — the caller falls back to the key's own all-time total.
function utcDaysForRange(range, now = new Date()) {
  const spans = { day: 1, week: 7, month: 30 };
  const days = spans[range];
  if (!days) return null;
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(now.getTime() - i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return new Set(out);
}

function summarizeActivity(activity, range) {
  const window = utcDaysForRange(range);
  const rows = window ? activity.filter((r) => window.has(r.date)) : activity;
  const byModel = new Map();
  const byDay = new Map();
  let cost = 0;
  let requests = 0;
  for (const row of rows) {
    cost += row.cost;
    requests += row.requests;
    const model = byModel.get(row.model) || { model: row.model, cost: 0, requests: 0, tokens: 0 };
    model.cost += row.cost;
    model.requests += row.requests;
    model.tokens += row.promptTokens + row.completionTokens;
    byModel.set(row.model, model);
    const day = byDay.get(row.date) || { date: row.date, cost: 0, requests: 0 };
    day.cost += row.cost;
    day.requests += row.requests;
    byDay.set(row.date, day);
  }
  return {
    cost,
    requests,
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// The key endpoint works with an ordinary inference key and already carries
// rolling UTC totals, so it is the fallback whenever /activity is off-limits.
function spendFromKey(data, range) {
  if (!data) return null;
  const pick = {
    day: ['usage_daily', 'byok_usage_daily'],
    week: ['usage_weekly', 'byok_usage_weekly'],
    month: ['usage_monthly', 'byok_usage_monthly'],
    all: ['usage', 'byok_usage'],
  }[range] || ['usage', 'byok_usage'];
  return num(data[pick[0]]) + num(data[pick[1]]);
}

/**
 * Reads real spend for one dashboard range.
 * Never throws: every failure is reported as a warning with partial data.
 */
async function fetchSpend(range = 'all') {
  const key = apiKey();
  if (!key) return { enabled: false };

  const warnings = [];
  const keyRes = await callApi('/key', key);
  if (!keyRes.ok) {
    return { enabled: true, ok: false, warnings: [`OpenRouter key lookup failed: ${keyRes.error}`] };
  }
  const info = keyRes.data || {};
  const isManagement = Boolean(info.is_management_key || info.is_provisioning_key);

  let activity = [];
  if (isManagement) {
    const activityRes = await callApi('/activity', key);
    if (activityRes.ok) activity = normalizeActivity(activityRes.data);
    else warnings.push(`Per-model breakdown unavailable: ${activityRes.error}.`);
  } else {
    warnings.push('This is an inference key, so only rolling totals are available. A management key adds a 30-day per-model breakdown.');
  }

  let credits = null;
  if (isManagement) {
    const creditsRes = await callApi('/credits', key);
    if (creditsRes.ok) {
      credits = { purchased: num(creditsRes.data.total_credits), used: num(creditsRes.data.total_usage) };
      credits.remaining = credits.purchased - credits.used;
    }
  }

  const detail = activity.length ? summarizeActivity(activity, range) : null;
  // Prefer the key's own rolling total: it is authoritative for the current
  // partial day, which /activity (completed days only) does not yet include.
  const rolling = spendFromKey(info, range);
  const cost = rolling !== null ? rolling : (detail ? detail.cost : 0);

  return {
    enabled: true,
    ok: true,
    range,
    key: status(),
    keyLabel: info.label || null,
    isManagement,
    cost,
    costSource: rolling !== null ? 'key-rolling-total' : 'activity',
    requests: detail ? detail.requests : null,
    byModel: detail ? detail.byModel : [],
    byDay: detail ? detail.byDay : [],
    credits,
    limit: info.limit == null ? null : { cap: num(info.limit), remaining: num(info.limit_remaining), reset: info.limit_reset || null },
    totals: {
      day: spendFromKey(info, 'day'),
      week: spendFromKey(info, 'week'),
      month: spendFromKey(info, 'month'),
      all: spendFromKey(info, 'all'),
    },
    caveats: [
      'Covers every request made with this API key, including any traffic that did not come from this agent.',
      'OpenRouter totals roll over at midnight UTC; this dashboard groups by your local day.',
    ],
    warnings,
  };
}

module.exports = { enabled, fetchSpend, status, setKey, clearKey, _test: { normalizeActivity, summarizeActivity, spendFromKey, utcDaysForRange, mask, configPath, resetSession: () => { sessionKey = null; } } };
