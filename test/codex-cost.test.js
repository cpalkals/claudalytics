const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { _test } = require('../src/adapters/codex');

function usage(inputTokens, cachedInputTokens, outputTokens) {
  return { inputTokens, cachedInputTokens, outputTokens };
}

function tokenEvent({
  input = 0,
  cached = 0,
  output = 0,
  reasoning = 0,
  cumulativeInput = input,
  cumulativeCached = cached,
  cumulativeOutput = output,
  cumulativeReasoning = reasoning,
  rawTotal = input + output,
  cumulativeRawTotal = cumulativeInput + cumulativeOutput,
  timestamp = '2026-08-18T12:00:00.000Z',
} = {}) {
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          total_tokens: rawTotal,
        },
        total_token_usage: {
          input_tokens: cumulativeInput,
          cached_input_tokens: cumulativeCached,
          output_tokens: cumulativeOutput,
          reasoning_output_tokens: cumulativeReasoning,
          total_tokens: cumulativeRawTotal,
        },
        model_context_window: 1050000,
      },
    },
  };
}

function extract(events, model = 'gpt-5.6-sol') {
  const entries = [
    {
      type: 'session_meta',
      timestamp: '2026-08-18T11:59:00.000Z',
      payload: { id: 'session-id', timestamp: '2026-08-18T11:59:00.000Z', model, cwd: path.resolve('project') },
    },
    ...events,
  ];
  return _test.extractSession(entries, path.resolve('sessions', 'rollout-session-id.jsonl'), {}, {});
}

test('uses the official standard GPT-5.2 rates', () => {
  const pricing = _test.getPricing('gpt-5.2');
  assert.equal(pricing.input * 1e6, 1.75);
  assert.equal(pricing.cachedInput * 1e6, 0.175);
  assert.equal(pricing.output * 1e6, 14);

  const estimate = _test.estimateCost(usage(100, 40, 10), 'gpt-5.2');
  assert.equal(estimate.longContext, false);
  assert.ok(Math.abs(estimate.cost - 0.000252) < 1e-12);
});

test('applies the full-request long-context rates above 272K input tokens', () => {
  const estimate = _test.estimateCost(usage(300000, 200000, 1000), 'gpt-5.6-terra');
  assert.equal(estimate.longContext, true);
  assert.ok(Math.abs(estimate.cost - 0.498) < 1e-12);

  assert.equal(_test.estimateCost(usage(272000, 0, 1), 'gpt-5.6-terra').longContext, false);
  assert.equal(_test.estimateCost(usage(300000, 0, 1), 'gpt-5.4-mini').longContext, false);
});

test('does not invent a price for an unknown or internal model name', () => {
  assert.equal(_test.getPricing('codex-auto-review'), null);
  assert.equal(_test.estimateCost(usage(1000, 0, 100), 'unknown'), null);
});

test('normalizes total tokens as input plus output and clamps invalid cache counts', () => {
  const parsed = _test.tokenUsageFromPayload(tokenEvent({
    input: 100,
    cached: 120,
    output: 20,
    reasoning: 30,
    rawTotal: 999,
  }).payload);

  assert.equal(parsed.cachedInputTokens, 100);
  assert.equal(parsed.reasoningOutputTokens, 20);
  assert.equal(parsed.totalTokens, 120);
});

test('deduplicates repeated cumulative snapshots before summing tokens and cost', () => {
  const first = tokenEvent({ input: 1000, cached: 600, output: 100 });
  const repeated = tokenEvent({ input: 1000, cached: 600, output: 100, timestamp: '2026-08-18T12:00:01.000Z' });
  const session = extract([first, repeated]);

  assert.equal(session.turnCount, 1);
  assert.equal(session.inputTokens, 1000);
  assert.equal(session.outputTokens, 100);
  assert.equal(session.totalTokens, 1100);
  assert.equal(session.cost, session.turns[0].cost);
  assert.equal(session.promptBreakdown[0].turns[0].cost, session.turns[0].cost);
  assert.equal(session.promptBreakdown[0].turns[0].costEstimated, true);
});

test('sums observed increments rather than an inherited cumulative baseline', () => {
  const session = extract([tokenEvent({
    input: 100,
    cached: 50,
    output: 10,
    cumulativeInput: 1000100,
    cumulativeCached: 900050,
    cumulativeOutput: 50010,
    cumulativeReasoning: 20000,
  })]);

  assert.equal(session.inputTokens, 100);
  assert.equal(session.cachedInputTokens, 50);
  assert.equal(session.outputTokens, 10);
  assert.equal(session.totalTokens, 110);
  assert.equal(session.pricedTokens, 110);
  assert.equal(session.unpricedTokens, 0);
});

test('keeps rate-limit snapshots that do not contain token usage', () => {
  const rateOnly = {
    type: 'event_msg',
    timestamp: '2026-08-18T12:00:00.000Z',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: { plan_type: 'plus', primary: { used_percent: 42 } },
    },
  };
  const session = extract([rateOnly, tokenEvent({ input: 10, output: 1 })]);
  assert.equal(session.turnCount, 1);
  assert.equal(session.rateLimit.planType, 'plus');
  assert.equal(session.rateLimit.primaryUsedPercent, 42);
});
