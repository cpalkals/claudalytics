const test = require('node:test');
const assert = require('node:assert/strict');

const openrouter = require('../src/openrouter');
const { normalizeActivity, summarizeActivity, spendFromKey, utcDaysForRange } = openrouter._test;

const KEY_INFO = {
  label: 'sk-or-v1-au7...890',
  usage: 25.5, usage_daily: 1.5, usage_weekly: 7.25, usage_monthly: 25.5,
  byok_usage: 2, byok_usage_daily: 0.5, byok_usage_weekly: 1, byok_usage_monthly: 2,
  is_management_key: false, limit: 100, limit_remaining: 74.5, limit_reset: 'monthly',
};

test('is off unless OPENROUTER_API_KEY is set', () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(openrouter.enabled(), false);
  process.env.OPENROUTER_API_KEY = '   ';
  assert.equal(openrouter.enabled(), false, 'whitespace is not a key');
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  assert.equal(openrouter.enabled(), true);
  if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = saved;
});

test('key totals add BYOK spend to credit spend for each window', () => {
  assert.equal(spendFromKey(KEY_INFO, 'day'), 2);
  assert.equal(spendFromKey(KEY_INFO, 'week'), 8.25);
  assert.equal(spendFromKey(KEY_INFO, 'month'), 27.5);
  assert.equal(spendFromKey(KEY_INFO, 'all'), 27.5);
  assert.equal(spendFromKey(KEY_INFO, 'nonsense'), 27.5, 'unknown range falls back to all-time');
});

test('activity rows are normalized and BYOK inference cost is included', () => {
  const rows = normalizeActivity([
    { date: '2026-08-24', model: 'anthropic/claude-opus-4.5', provider_name: 'Anthropic', requests: 5, prompt_tokens: 50, completion_tokens: 125, reasoning_tokens: 25, usage: 0.015, byok_usage_inference: 0.012 },
    { date: null, model: 'dropped/no-date', usage: 99 },
  ]);
  assert.equal(rows.length, 1, 'rows with no date are dropped');
  assert.equal(rows[0].cost, 0.027);
  assert.equal(rows[0].provider, 'Anthropic');
  assert.equal(rows[0].reasoningTokens, 25);
});

test('the range window counts whole UTC days back from now', () => {
  const now = new Date('2026-08-26T04:00:00Z');
  assert.deepEqual([...utcDaysForRange('day', now)], ['2026-08-26']);
  assert.equal(utcDaysForRange('week', now).size, 7);
  assert.equal(utcDaysForRange('month', now).size, 30);
  assert.equal(utcDaysForRange('all', now), null, 'all time is unfiltered');
});

test('activity is summarized by model and by day', () => {
  const activity = normalizeActivity([
    { date: '2026-08-25', model: 'a/one', requests: 2, prompt_tokens: 100, completion_tokens: 10, usage: 1 },
    { date: '2026-08-25', model: 'a/two', requests: 1, prompt_tokens: 10, completion_tokens: 5, usage: 3 },
    { date: '2026-08-24', model: 'a/one', requests: 4, prompt_tokens: 200, completion_tokens: 20, usage: 2 },
  ]);
  const all = summarizeActivity(activity, 'all');
  assert.equal(all.cost, 6);
  assert.equal(all.requests, 7);
  assert.deepEqual(all.byModel.map((m) => m.model), ['a/one', 'a/two'], 'ranked by spend');
  assert.equal(all.byModel[0].cost, 3);
  assert.equal(all.byModel[0].tokens, 330);
  assert.deepEqual(all.byDay.map((d) => d.date), ['2026-08-24', '2026-08-25'], 'chronological');
});

// --- fetchSpend against a stubbed OpenRouter --------------------------------
function stubFetch(routes) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    for (const [fragment, reply] of Object.entries(routes)) {
      if (String(url).includes(fragment)) return reply;
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return calls;
}
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => ({ data }) });

test('an inference key yields rolling totals and says why there is no breakdown', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  const calls = stubFetch({ '/key': json(KEY_INFO) });

  const out = await openrouter.fetchSpend('week');
  assert.equal(out.ok, true);
  assert.equal(out.cost, 8.25);
  assert.equal(out.isManagement, false);
  assert.deepEqual(out.byModel, [], 'no per-model data without a management key');
  assert.ok(out.warnings.some((w) => w.includes('management key')));
  assert.equal(out.limit.remaining, 74.5);
  assert.ok(calls.every((c) => c.auth === 'Bearer sk-or-test'));
  assert.ok(!calls.some((c) => c.url.includes('/activity')), 'does not call an endpoint the key cannot use');
});

test('a management key adds the per-model breakdown and credit balance', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });
  process.env.OPENROUTER_API_KEY = 'sk-or-mgmt';
  stubFetch({
    '/key': json({ ...KEY_INFO, is_management_key: true }),
    '/activity': json([{ date: new Date().toISOString().slice(0, 10), model: 'anthropic/claude-opus-4.5', requests: 3, prompt_tokens: 10, completion_tokens: 5, usage: 0.5 }]),
    '/credits': json({ total_credits: 100.5, total_usage: 25.75 }),
  });

  const out = await openrouter.fetchSpend('day');
  assert.equal(out.isManagement, true);
  assert.equal(out.byModel[0].model, 'anthropic/claude-opus-4.5');
  assert.equal(out.requests, 3);
  assert.equal(Number(out.credits.remaining.toFixed(2)), 74.75);
  // The key's rolling total wins: /activity only covers completed UTC days.
  assert.equal(out.cost, 2);
  assert.equal(out.costSource, 'key-rolling-total');
});

test('a rejected key degrades to a warning instead of throwing', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });
  process.env.OPENROUTER_API_KEY = 'sk-or-bad';
  stubFetch({ '/key': { ok: false, status: 401, json: async () => ({}) } });

  const out = await openrouter.fetchSpend('all');
  assert.equal(out.enabled, true);
  assert.equal(out.ok, false);
  assert.ok(out.warnings[0].includes('rejected'));
});

test('a network failure is reported, not thrown', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
  global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };

  const out = await openrouter.fetchSpend('all');
  assert.equal(out.ok, false);
  assert.ok(out.warnings[0].includes('Could not reach OpenRouter'));
});

test('the payload never carries the API key back to the browser', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; delete process.env.OPENROUTER_API_KEY; });
  process.env.OPENROUTER_API_KEY = 'sk-or-secret-value';
  stubFetch({ '/key': json(KEY_INFO) });

  const out = await openrouter.fetchSpend('all');
  assert.ok(!JSON.stringify(out).includes('sk-or-secret-value'));
});
