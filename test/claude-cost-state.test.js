const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/adapters/claude');
const { latestCostState, reconcileWithCostState } = _test;

test('latestCostState keeps the last cumulative snapshot in the file', () => {
  const entries = [
    { type: 'cost-state', modelUsage: { 'claude-sonnet-5': { costUSD: 0.10 } } },
    { type: 'assistant' },
    { type: 'cost-state', modelUsage: { 'claude-sonnet-5': { costUSD: 0.65 } } },
  ];
  const latest = latestCostState(entries);
  assert.equal(latest.modelUsage['claude-sonnet-5'].costUSD, 0.65);
});

test('latestCostState is null when the session never wrote one', () => {
  assert.equal(latestCostState([{ type: 'assistant' }, { type: 'user' }]), null);
});

test("rescales turn costs to match Claude Code's own reported per-model total", () => {
  const turns = [
    { model: 'claude-sonnet-5', cost: 0.40, totalTokens: 1000, costEstimated: true, costReported: false },
    { model: 'claude-sonnet-5', cost: 0.10, totalTokens: 250, costEstimated: true, costReported: false },
  ];
  const costState = { modelUsage: { 'claude-sonnet-5': { costUSD: 1.00 } } };
  reconcileWithCostState(turns, costState);

  // Total now matches the reported figure exactly...
  assert.ok(Math.abs(turns[0].cost + turns[1].cost - 1.00) < 1e-9);
  // ...and the relative split between the two turns is preserved (4:1, same
  // ratio as the original 0.40 : 0.10 estimate).
  assert.ok(Math.abs(turns[0].cost / turns[1].cost - 4) < 1e-9);
  assert.equal(turns[0].costReported, true);
  assert.equal(turns[1].costReported, true);
});

test('does not touch a different model in the same session', () => {
  const turns = [
    { model: 'claude-sonnet-5', cost: 0.40, totalTokens: 1000, costEstimated: true, costReported: false },
    { model: 'claude-haiku-4.5', cost: 0.02, totalTokens: 500, costEstimated: true, costReported: false },
  ];
  reconcileWithCostState(turns, { modelUsage: { 'claude-sonnet-5': { costUSD: 1.00 } } });

  assert.equal(turns[0].cost, 1.00);
  assert.equal(turns[1].cost, 0.02, 'no cost-state entry for this model, so it keeps its own estimate');
  assert.equal(turns[1].costReported, false);
});

test('falls back to a token-share split when our table treated the model as unpriced', () => {
  const turns = [
    { model: 'sonnet', cost: 0, totalTokens: 800, costEstimated: false, costReported: false },
    { model: 'sonnet', cost: 0, totalTokens: 200, costEstimated: false, costReported: false },
  ];
  reconcileWithCostState(turns, { modelUsage: { sonnet: { costUSD: 0.50 } } });

  assert.ok(Math.abs(turns[0].cost - 0.40) < 1e-9);
  assert.ok(Math.abs(turns[1].cost - 0.10) < 1e-9);
  assert.equal(turns[0].costEstimated, true);
  assert.equal(turns[0].costReported, true);
});

test('leaves turns untouched when there is no snapshot or no matching model', () => {
  const turns = [{ model: 'claude-opus-5', cost: 0.20, totalTokens: 500, costEstimated: true, costReported: false }];

  reconcileWithCostState(turns, null);
  assert.equal(turns[0].cost, 0.20);
  assert.equal(turns[0].costReported, false);

  reconcileWithCostState(turns, { modelUsage: { 'claude-sonnet-5': { costUSD: 1 } } });
  assert.equal(turns[0].cost, 0.20);
  assert.equal(turns[0].costReported, false);
});

test('does nothing when both the estimate and the token total are zero', () => {
  const turns = [{ model: 'claude-opus-5', cost: 0, totalTokens: 0, costEstimated: false, costReported: false }];
  reconcileWithCostState(turns, { modelUsage: { 'claude-opus-5': { costUSD: 5 } } });

  assert.equal(turns[0].cost, 0);
  assert.equal(turns[0].costReported, false);
});

test('ignores a costUSD that is missing, non-finite, or the wrong type', () => {
  const turns = [{ model: 'claude-opus-5', cost: 0.20, totalTokens: 500, costEstimated: true, costReported: false }];
  for (const badUsage of [{}, { costUSD: NaN }, { costUSD: '0.5' }, { costUSD: null }]) {
    reconcileWithCostState(turns, { modelUsage: { 'claude-opus-5': badUsage } });
    assert.equal(turns[0].cost, 0.20);
    assert.equal(turns[0].costReported, false);
  }
});
