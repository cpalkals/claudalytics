// OpenRouter spend lookup — turns the local token estimate into a reconciliation
// against what OpenRouter actually billed.
//
// The key is read from the environment on every call and never written anywhere:
// no config file, no cache on disk, and it is not included in any API response
// (only a masked label OpenRouter itself returns).
//
// Scope caveats, surfaced in the payload so the UI can state them:
//  - Figures are per API key, so they include any non-OpenCode traffic on it.
//  - OpenRouter buckets by UTC day; this dashboard buckets by local day.
//  - Per-request reconciliation is impossible: OpenRouter's exact per-generation
//    cost needs a generation id, and OpenCode never records one.
const BASE = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 8000;

function apiKey() {
  const key = (process.env.OPENROUTER_API_KEY || '').trim();
  return key || null;
}

function enabled() {
  return apiKey() !== null;
}

async function callApi(path, key) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
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

module.exports = { enabled, fetchSpend, _test: { normalizeActivity, summarizeActivity, spendFromKey, utcDaysForRange } };
