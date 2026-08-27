const test = require('node:test');
const assert = require('node:assert/strict');
const { splitPricedTokens, unpricedModelWarning } = require('../src/adapters/aggregate');

test('splitPricedTokens sums totalTokens into priced vs unpriced buckets', () => {
  const turns = [
    { costEstimated: true, totalTokens: 100 },
    { costEstimated: true, totalTokens: 50 },
    { costEstimated: false, totalTokens: 30 },
  ];
  assert.deepEqual(splitPricedTokens(turns), { pricedTokens: 150, unpricedTokens: 30 });
});

test('splitPricedTokens handles an all-priced session, an all-unpriced one, and an empty one', () => {
  assert.deepEqual(splitPricedTokens([{ costEstimated: true, totalTokens: 10 }]), { pricedTokens: 10, unpricedTokens: 0 });
  assert.deepEqual(splitPricedTokens([{ costEstimated: false, totalTokens: 10 }]), { pricedTokens: 0, unpricedTokens: 10 });
  assert.deepEqual(splitPricedTokens([]), { pricedTokens: 0, unpricedTokens: 0 });
});

test('unpricedModelWarning names every model with an unpriced turn, across sessions', () => {
  const sessions = [
    { turns: [{ costEstimated: true, model: 'claude-sonnet-5' }, { costEstimated: false, model: 'claude-opus' }] },
    { turns: [{ costEstimated: false, model: 'gpt-5.9-preview' }] },
  ];
  const warning = unpricedModelWarning(sessions);
  assert.equal(warning.type, 'unpriced-model');
  assert.match(warning.message, /claude-opus/);
  assert.match(warning.message, /gpt-5\.9-preview/);
  assert.doesNotMatch(warning.message, /claude-sonnet-5/, 'a priced model should not be named');
});

test('unpricedModelWarning is null when every turn was priced', () => {
  const sessions = [{ turns: [{ costEstimated: true, model: 'claude-sonnet-5' }] }];
  assert.equal(unpricedModelWarning(sessions), null);
});

test('unpricedModelWarning falls back to "unknown" for a turn with no model', () => {
  const sessions = [{ turns: [{ costEstimated: false, model: null }] }];
  assert.match(unpricedModelWarning(sessions).message, /unknown/);
});
