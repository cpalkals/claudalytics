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
