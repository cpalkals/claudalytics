const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/adapters/claude');
const { getPricing } = _test;

const rate = (model) => [getPricing(model).input * 1e6, getPricing(model).output * 1e6];

test('prices the Claude 5 family at its own rates, not the Opus 4.0 fallback', () => {
  assert.deepEqual(rate('claude-opus-5'), [5, 25]);
  assert.deepEqual(rate('claude-opus-5[1m]'), [5, 25]);
  assert.deepEqual(rate('claude-fable-5'), [10, 50]);
  assert.deepEqual(rate('claude-sonnet-5'), [2, 10]);
});

test('keeps the older tiers on their historical rates', () => {
  assert.deepEqual(rate('claude-opus-4-1-20250805'), [15, 75]);
  assert.deepEqual(rate('claude-opus-4-20250514'), [15, 75]);
  assert.deepEqual(rate('claude-opus-4-5-20251101'), [5, 25]);
  assert.deepEqual(rate('claude-opus-4-6'), [5, 25]);
  assert.deepEqual(rate('claude-sonnet-4-6'), [3, 15]);
  assert.deepEqual(rate('claude-3-5-sonnet-20241022'), [3, 15]);
  assert.deepEqual(rate('claude-haiku-4-5'), [1, 5]);
  assert.deepEqual(rate('claude-3-5-haiku-20241022'), [0.8, 4]);
});

test('cache rates stay at the 1.25x write / 0.1x read multipliers', () => {
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5']) {
    const p = getPricing(model);
    assert.equal(Number((p.cacheWrite / p.input).toFixed(4)), 1.25, model);
    assert.equal(Number((p.cacheRead / p.input).toFixed(4)), 0.1, model);
  }
});

test('does not invent a price for a bare, version-ambiguous family alias', () => {
  for (const model of ['opus', 'sonnet', 'haiku', 'fable', 'Opus', 'SONNET']) {
    assert.equal(getPricing(model), null, model);
  }
  assert.equal(getPricing('some-future-model-id'), null);
  assert.equal(getPricing(''), null);
});

test('prices Opus 5.5 and Fable 5.1 at their own rates and discounted cache reads', () => {
  assert.deepEqual(rate('claude-opus-5-5'), [4, 20]);
  assert.deepEqual(rate('claude-opus-5-5[1m]'), [4, 20]);
  assert.deepEqual(rate('claude-fable-5-1'), [10, 50]);
  assert.equal(getPricing('claude-opus-5-5').cacheWrite * 1e6, 5);
  assert.equal(Number((getPricing('claude-opus-5-5').cacheRead * 1e6).toFixed(4)), 0.2);
  assert.equal(getPricing('claude-fable-5-1').cacheRead * 1e6, 0.25);
  assert.equal(getPricing('claude-mythos-5-1').cacheRead * 1e6, 0.25);
  // Fable 5 keeps the standard 0.1x cache-read rate.
  assert.equal(getPricing('claude-fable-5').cacheRead * 1e6, 1);
});

test('does not mistake a dated Opus 5 / Fable 5 snapshot for the .5 / .1 release', () => {
  assert.deepEqual(rate('claude-opus-5-20260401'), [5, 25]);
  assert.equal(getPricing('claude-fable-5-10000000').cacheRead * 1e6, 1);
});

test('prices Fable 5.2, Sonnet 5.5 and Haiku 5.5 at their own rates', () => {
  const all = (model) => {
    const p = getPricing(model);
    return [p.input, p.output, p.cacheWrite, p.cacheWrite1h, p.cacheRead].map((n) => Number((n * 1e6).toFixed(4)));
  };
  assert.deepEqual(all('claude-fable-5-2'), [8, 40, 10, 16, 0.2]);
  assert.deepEqual(all('claude-mythos-5-2'), [8, 40, 10, 16, 0.2]);
  assert.deepEqual(all('claude-sonnet-5-5'), [2, 10, 2.5, 4, 0.1]);
  assert.deepEqual(all('claude-haiku-5-5'), [0.1, 0.5, 0.125, 0.2, 0.01]);
  // Their predecessors keep their own rates.
  assert.deepEqual(all('claude-sonnet-5'), [2, 10, 2.5, 4, 0.2]);
  assert.deepEqual(all('claude-haiku-4-5-20251001'), [1, 5, 1.25, 2, 0.1]);
  assert.deepEqual(all('claude-fable-5-1'), [10, 50, 12.5, 20, 0.25]);
});

test('Haiku 5.5 uses the long-prompt rates only once the whole prompt exceeds 100K tokens', () => {
  const { ratesForPrompt } = _test;
  const p = getPricing('claude-haiku-5-5');
  assert.equal(ratesForPrompt(p, 100000), p);
  const long = ratesForPrompt(p, 100001);
  assert.deepEqual([long.input, long.output, long.cacheWrite, long.cacheWrite1h, long.cacheRead].map((n) => Number((n * 1e6).toFixed(4))), [0.5, 2.5, 0.625, 1, 0.05]);
  // Other models have no prompt-length tier.
  assert.equal(ratesForPrompt(getPricing('claude-opus-5-5'), 900000), getPricing('claude-opus-5-5'));
});

test('bills 1-hour cache writes at 2x input and the rest at the 5-minute rate', () => {
  const { turnCost } = _test;
  const p = getPricing('claude-opus-5-5');
  const cost = turnCost(p, {
    input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10000,
    cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
  });
  assert.ok(Math.abs(cost - (1000 * 4 + 1000 * 5 + 2000 * 8 + 10000 * 0.2 + 100 * 20) / 1e6) < 1e-12);
  // Logs without the TTL breakdown price every write as a 5-minute write.
  const legacy = turnCost(p, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 3000 });
  assert.ok(Math.abs(legacy - 3000 * 5 / 1e6) < 1e-12);
});

test('uses the TTL breakdown when the total cache-write count is missing', () => {
  const { turnCost } = _test;
  const p = getPricing('claude-opus-5-5');
  const cost = turnCost(p, { cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } });
  assert.ok(Math.abs(cost - (1000 * 5 + 2000 * 8) / 1e6) < 1e-12);
});
