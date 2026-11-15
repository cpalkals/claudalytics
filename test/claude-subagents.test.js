const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claude = require('../src/adapters/claude');

const MODEL = 'claude-opus-5-5';
const line = (o) => JSON.stringify(o);
const user = (text, timestamp) => line({ type: 'user', timestamp, cwd: '/work/demo-app', message: { role: 'user', content: text } });
const reply = (id, timestamp, output, tool) => line({
  type: 'assistant', timestamp,
  message: {
    id, model: MODEL, role: 'assistant',
    content: tool ? [{ type: 'tool_use', id: `tu-${id}`, name: tool, input: {} }] : [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output },
  },
});

function fixture({ withCostState }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claudalytics-sub-'));
  const project = path.join(home, 'projects', '-work-demo-app');
  const sessionId = 'session-1';
  fs.mkdirSync(path.join(project, sessionId, 'subagents'), { recursive: true });
  const main = [
    user('build the thing', '2026-11-10T10:00:00Z'),
    reply('msg-main-1', '2026-11-10T10:00:05Z', 100000, 'Task'),
    reply('msg-main-2', '2026-11-10T10:05:00Z', 100000),
  ];
  // Snapshot covers both files: 300K output tokens at $20/M = $6, reported as $9.
  if (withCostState) main.push(line({ type: 'cost-state', startTime: Date.parse('2026-11-10T09:59:00Z'), modelUsage: { [MODEL]: { costUSD: 9 } } }));
  fs.writeFileSync(path.join(project, `${sessionId}.jsonl`), main.join('\n') + '\n');
  fs.writeFileSync(path.join(project, sessionId, 'subagents', 'agent-a.jsonl'), [
    user('subagent task text', '2026-11-10T10:00:06Z'),
    reply('msg-sub-1', '2026-11-10T10:01:00Z', 100000, 'Grep'),
  ].join('\n') + '\n');
  return home;
}

test('folds a subagent transcript into its parent session', async () => {
  const home = fixture({ withCostState: false });
  const result = await claude.parse({ home });
  assert.equal(result.sessions.length, 1, 'the subagent is not a separate session');
  const [session] = result.sessions;
  assert.equal(session.turnCount, 3);
  assert.equal(session.outputTokens, 300000);
  assert.ok(Math.abs(session.cost - 6) < 1e-9, 'subagent tokens are priced too');
  assert.equal(session.toolCounts.Grep, 1);
  const sub = session.turns.find((t) => t.turnId === 'msg-sub-1');
  assert.equal(sub.prompt, 'build the thing', 'filed under the main prompt that spawned it');
  assert.deepEqual(session.turns.map((t) => t.turnId), ['msg-main-1', 'msg-sub-1', 'msg-main-2']);

  const { items } = await claude.content(session, { home });
  assert.deepEqual(items.map((i) => i.turnId), ['msg-main-1', 'msg-sub-1', 'msg-main-2']);
});

test("reconciles subagent turns against the parent's snapshot, which already includes them", async () => {
  const home = fixture({ withCostState: true });
  const [session] = (await claude.parse({ home })).sessions;
  assert.ok(Math.abs(session.cost - 9) < 1e-9, 'total matches the snapshot, not snapshot + subagent');
});
