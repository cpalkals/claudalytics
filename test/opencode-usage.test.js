const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const adapter = require('../src/adapters/opencode');
const { usageFromParts, getPricing, estimateCost } = adapter._test;

const step = (input, output, reasoning, read, write, cost) => ({
  type: 'step-finish',
  cost,
  tokens: { input, output, reasoning, cache: { read, write } },
});

test('sums every step-finish part, not just the last step', () => {
  const parts = [step(100, 50, 10, 900, 200, 0.01), step(120, 60, 20, 1000, 0, 0.02)];
  // message.data.tokens only ever holds the LAST step (opencode overwrites it)
  const d = { tokens: parts[1].tokens, cost: 0.03 };
  const u = usageFromParts(parts, d);
  assert.equal(u.inputTokens, 100 + 900 + 200 + 120 + 1000);
  assert.equal(u.cachedInputTokens, 1900);
  assert.equal(u.outputTokens, 50 + 10 + 60 + 20);
  assert.equal(u.reasoningOutputTokens, 30);
  assert.equal(u.totalTokens, u.inputTokens + u.outputTokens);
  assert.equal(u.recordedCost, 0.03);
});

test('falls back to message tokens when no step-finish parts exist', () => {
  const d = { tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 7, write: 3 } }, cost: 0.5 };
  const u = usageFromParts([{ type: 'text', text: 'hi' }], d);
  assert.deepEqual(
    { i: u.inputTokens, c: u.cachedInputTokens, o: u.outputTokens, r: u.reasoningOutputTokens, cost: u.recordedCost },
    { i: 20, c: 7, o: 7, r: 2, cost: 0.5 },
  );
});

test('ignores malformed/negative token values', () => {
  const u = usageFromParts([step(-5, NaN, undefined, '900', null, 'x')], { cost: undefined });
  assert.equal(u.inputTokens, 900);
  assert.equal(u.outputTokens, 0);
  assert.equal(u.recordedCost, 0);
});

test('parse() token totals match the session rollup columns opencode maintains', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, path TEXT,
      title TEXT, cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0,
      model TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `);
  const steps = [step(100, 50, 10, 900, 200, 0.01), step(120, 60, 20, 1000, 0, 0.02)];
  const rollup = steps.reduce((a, s) => ({
    input: a.input + s.tokens.input, output: a.output + s.tokens.output,
    reasoning: a.reasoning + s.tokens.reasoning,
    read: a.read + s.tokens.cache.read, write: a.write + s.tokens.cache.write,
    cost: a.cost + s.cost,
  }), { input: 0, output: 0, reasoning: 0, read: 0, write: 0, cost: 0 });
  db.prepare(`INSERT INTO session (id, project_id, directory, title, cost, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write, model, time_created, time_updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('ses_1', 'prj', '/tmp/proj', 'demo', rollup.cost, rollup.input, rollup.output,
      rollup.reasoning, rollup.read, rollup.write, JSON.stringify({ modelID: 'claude-opus-5' }), 1000, 2000);
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
    .run('msg_u', 'ses_1', 1000, JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)')
    .run('prt_u', 'msg_u', 'ses_1', JSON.stringify({ type: 'text', text: 'do a thing' }));
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
    .run('msg_a', 'ses_1', 1500, JSON.stringify({ role: 'assistant', modelID: 'claude-opus-5', cost: rollup.cost, tokens: steps[1].tokens }));
  steps.forEach((s, i) => db.prepare('INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)')
    .run(`prt_s${i}`, 'msg_a', 'ses_1', JSON.stringify(s)));
  db.prepare('INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)')
    .run('prt_t', 'msg_a', 'ses_1', JSON.stringify({ type: 'tool', tool: 'bash', state: { input: {}, output: 'ok' } }));
  db.close();

  const result = await adapter.parse({ home: dir });
  const s = result.sessions[0];
  assert.equal(s.inputTokens, rollup.input + rollup.read + rollup.write);
  assert.equal(s.cachedInputTokens, rollup.read);
  assert.equal(s.outputTokens, rollup.output + rollup.reasoning);
  assert.equal(s.reasoningOutputTokens, rollup.reasoning);
  assert.equal(s.totalTokens, s.inputTokens + s.outputTokens);
  assert.equal(Number(s.cost.toFixed(6)), Number(rollup.cost.toFixed(6)));
  assert.equal(s.toolCounts.bash, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prices known models and refuses to guess at unknown ones', () => {
  assert.equal(getPricing('claude-opus-5').output, 25 / 1e6);
  assert.equal(getPricing('claude-fable-5').input, 10 / 1e6);
  assert.equal(getPricing('claude-sonnet-5').input, 2 / 1e6);
  assert.equal(getPricing('gpt-5.4').output, 15 / 1e6);
  assert.equal(getPricing('gemini-3-pro').output, 12 / 1e6);
  assert.equal(getPricing('my-local-llama'), null);
  assert.equal(getPricing('unknown'), null);
  assert.equal(estimateCost('my-local-llama', { freshInputTokens: 1e6, cacheWriteTokens: 0, cachedInputTokens: 0, outputTokens: 0 }), null);
});

test('estimate charges fresh input, cache write, cache read and output separately', () => {
  const cost = estimateCost('claude-opus-5', {
    freshInputTokens: 1e6, cacheWriteTokens: 1e6, cachedInputTokens: 1e6, outputTokens: 1e6,
  });
  assert.equal(Number(cost.toFixed(4)), 5 + 6.25 + 0.5 + 25);
});

function sessionDb(dir, { model, recordedCost }) {
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
      model TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `);
  db.prepare('INSERT INTO session (id, project_id, directory, title, model, time_created, time_updated) VALUES (?,?,?,?,?,?,?)')
    .run('ses_1', 'prj', '/tmp/proj', 'demo', JSON.stringify({ modelID: model }), 1000, 2000);
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
    .run('msg_a', 'ses_1', 1500, JSON.stringify({ role: 'assistant', modelID: model, cost: recordedCost }));
  db.prepare('INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)')
    .run('prt_s', 'msg_a', 'ses_1', JSON.stringify(step(1e6, 1e6, 0, 1e6, 1e6, recordedCost)));
  db.close();
  return file;
}

test('keeps the cost OpenCode recorded rather than re-pricing it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-priced-'));
  sessionDb(dir, { model: 'claude-opus-5', recordedCost: 1.2345 });
  const result = await adapter.parse({ home: dir });
  assert.equal(result.sessions[0].cost, 1.2345);
  assert.equal(result.sessions[0].backfilledCost, 0);
  assert.equal(result.sessions[0].unpricedTokens, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('back-fills an estimate when OpenCode recorded $0 for a known model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-backfill-'));
  sessionDb(dir, { model: 'claude-opus-5', recordedCost: 0 });
  const result = await adapter.parse({ home: dir });
  const s = result.sessions[0];
  // 1M fresh in, 1M cache write, 1M cache read, 1M output (+0 reasoning)
  assert.equal(Number(s.cost.toFixed(4)), 5 + 6.25 + 0.5 + 25);
  assert.equal(Number(s.backfilledCost.toFixed(4)), Number(s.cost.toFixed(4)));
  assert.equal(s.unpricedTokens, 0);
  assert.ok(result.warnings.some((w) => w.type === 'cost-backfilled'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('marks tokens unpriced when neither OpenCode nor our table has a rate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-unpriced-'));
  sessionDb(dir, { model: 'my-local-llama', recordedCost: 0 });
  const result = await adapter.parse({ home: dir });
  const s = result.sessions[0];
  assert.equal(s.cost, 0);
  assert.equal(s.pricedTokens, 0);
  assert.equal(s.unpricedTokens, s.totalTokens);
  assert.ok(result.warnings.some((w) => w.type === 'cost-unpriced'));
  fs.rmSync(dir, { recursive: true, force: true });
});
