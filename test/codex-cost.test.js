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

test('drops the replayed ancestor burst in a forked or subagent rollout', () => {
  const forkMeta = {
    type: 'session_meta',
    timestamp: '2026-08-18T12:00:00.000Z',
    payload: {
      id: 'child-session', timestamp: '2026-08-18T12:00:00.000Z',
      model: 'gpt-5.6-sol', cwd: path.resolve('project'), forked_from_id: 'parent-session',
    },
  };
  // Copied ancestor history, re-stamped moments after the fork's own meta —
  // already counted once in the parent's own rollout file.
  const replayedAncestorUsage = tokenEvent({ input: 5000, cached: 1000, output: 500, timestamp: '2026-08-18T12:00:00.030Z' });
  // A real turn, separated by several seconds — this is genuine to the fork.
  const genuineUsage = tokenEvent({ input: 100, cached: 0, output: 20, timestamp: '2026-08-18T12:00:07.000Z' });

  const session = _test.extractSession(
    [forkMeta, replayedAncestorUsage, genuineUsage],
    path.resolve('sessions', 'rollout-child.jsonl'), {}, {},
  );

  assert.equal(session.turnCount, 1, 'the replayed ancestor burst should be dropped');
  assert.equal(session.inputTokens, 100);
  assert.equal(session.outputTokens, 20);
});

test('subagent thread_spawn is recognized the same way as a plain fork', () => {
  const spawnMeta = {
    type: 'session_meta',
    timestamp: '2026-08-18T12:00:00.000Z',
    payload: {
      id: 'subagent-session', timestamp: '2026-08-18T12:00:00.000Z', model: 'gpt-5.6-sol',
      cwd: path.resolve('project'), source: { subagent: { thread_spawn: { parent_thread_id: 'parent-session' } } },
    },
  };
  const replayed = tokenEvent({ input: 5000, output: 500, timestamp: '2026-08-18T12:00:00.010Z' });
  const genuine = tokenEvent({ input: 50, output: 5, timestamp: '2026-08-18T12:00:06.000Z' });
  const session = _test.extractSession([spawnMeta, replayed, genuine], path.resolve('sessions', 'rollout-subagent.jsonl'), {}, {});

  assert.equal(session.turnCount, 1);
  assert.equal(session.inputTokens, 50);
});

test('a session_meta without a fork or subagent marker never suppresses anything', () => {
  const plainMeta = {
    type: 'session_meta',
    timestamp: '2026-08-18T12:00:00.000Z',
    payload: { id: 'plain-session', timestamp: '2026-08-18T12:00:00.000Z', model: 'gpt-5.6-sol', cwd: path.resolve('project') },
  };
  const first = tokenEvent({ input: 10, output: 1, timestamp: '2026-08-18T12:00:00.010Z' });
  const second = tokenEvent({ input: 20, output: 2, timestamp: '2026-08-18T12:00:00.020Z' });
  const session = _test.extractSession([plainMeta, first, second], path.resolve('sessions', 'rollout-plain.jsonl'), {}, {});

  assert.equal(session.turnCount, 2);
  assert.equal(session.inputTokens, 30);
});

test('isForkedSessionMeta recognizes both fork and subagent-spawn shapes', () => {
  assert.equal(_test.isForkedSessionMeta({ forked_from_id: 'abc' }), true);
  assert.equal(_test.isForkedSessionMeta({ source: { subagent: { thread_spawn: { parent_thread_id: 'abc' } } } }), true);
  assert.equal(_test.isForkedSessionMeta({}), false);
  assert.equal(_test.isForkedSessionMeta({ source: { subagent: {} } }), false);
});

test('stripForkedHistory drops the burst but keeps entries before and after it', () => {
  const before = { type: 'response_item', timestamp: '2026-08-18T11:59:00.000Z', payload: { type: 'message' } };
  const meta = {
    type: 'session_meta', timestamp: '2026-08-18T12:00:00.000Z',
    payload: { id: 'child-session', forked_from_id: 'parent-session' },
  };
  const replayedMeta = { type: 'session_meta', timestamp: '2026-08-18T12:00:00.005Z', payload: { id: 'parent-session' } };
  const replayedBurst = { type: 'response_item', timestamp: '2026-08-18T12:00:00.030Z', payload: { type: 'message' } };
  const genuine = { type: 'response_item', timestamp: '2026-08-18T12:00:07.000Z', payload: { type: 'message' } };

  const result = _test.stripForkedHistory([before, meta, replayedMeta, replayedBurst, genuine]);
  assert.deepEqual(result, [before, meta, genuine]);
});

test('stripForkedHistory drops every entry when the burst never ends before EOF', () => {
  const meta = { type: 'session_meta', timestamp: '2026-08-18T12:00:00.000Z', payload: { forked_from_id: 'parent-session' } };
  const replayed1 = { type: 'response_item', timestamp: '2026-08-18T12:00:00.010Z', payload: {} };
  const replayed2 = { type: 'response_item', timestamp: '2026-08-18T12:00:00.020Z', payload: {} };
  assert.deepEqual(_test.stripForkedHistory([meta, replayed1, replayed2]), [meta]);
});

test('stripForkedHistory is a no-op for a plain, unforked session', () => {
  const meta = { type: 'session_meta', timestamp: '2026-08-18T12:00:00.000Z', payload: { id: 'plain' } };
  const first = { type: 'response_item', timestamp: '2026-08-18T12:00:00.010Z', payload: {} };
  const entries = [meta, first];
  assert.deepEqual(_test.stripForkedHistory(entries), entries);
});

test('stripForkedHistory returns entries untouched when there is no session_meta at all', () => {
  const entries = [{ type: 'response_item', timestamp: '2026-08-18T12:00:00.000Z', payload: {} }];
  assert.deepEqual(_test.stripForkedHistory(entries), entries);
});
