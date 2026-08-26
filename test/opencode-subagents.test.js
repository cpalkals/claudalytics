const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const adapter = require('../src/adapters/opencode');

const step = (input, output, read) => ({
  type: 'step-finish', cost: 0.01,
  tokens: { input, output, reasoning: 0, cache: { read, write: 0 } },
});

// Builds a db from a list of {id, parentId, title, prompt, at} session specs.
// Each session gets one user prompt and one assistant turn worth 1,100 tokens.
function buildDb(specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sub-'));
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT,
      title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `);
  const sess = db.prepare('INSERT INTO session (id, project_id, parent_id, directory, title, model, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)');
  const msg = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)');
  const part = db.prepare('INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)');
  for (const spec of specs) {
    const { id, parentId = null, title = id, prompt = null, at = 1000, silent = false } = spec;
    sess.run(id, 'prj', parentId, '/tmp/proj', title, JSON.stringify({ modelID: 'claude-opus-5' }), at, at + 100);
    if (silent) continue;
    msg.run(`${id}-u`, id, at, JSON.stringify({ role: 'user' }));
    if (prompt) part.run(`${id}-up`, `${id}-u`, id, JSON.stringify({ type: 'text', text: prompt }));
    msg.run(`${id}-a`, id, at + 50, JSON.stringify({ role: 'assistant', modelID: 'claude-opus-5', cost: 0.01 }));
    part.run(`${id}-as`, `${id}-a`, id, JSON.stringify(step(100, 100, 900)));
    part.run(`${id}-at`, `${id}-a`, id, JSON.stringify({ type: 'tool', tool: `tool-${id}`, state: {} }));
  }
  db.close();
  return dir;
}

const TURN_TOKENS = 100 + 900 + 100; // fresh input + cache read + output

test('folds helper sessions into the session that spawned them', async () => {
  const dir = buildDb([
    { id: 'ses_main', prompt: 'refactor the parser', at: 1000 },
    { id: 'ses_help1', parentId: 'ses_main', title: 'read the files', at: 2000 },
    { id: 'ses_help2', parentId: 'ses_main', title: 'write the tests', at: 3000 },
  ]);
  const result = await adapter.parse({ home: dir });

  assert.equal(result.sessions.length, 1, 'helpers should not be listed separately');
  const s = result.sessions[0];
  assert.equal(s.sessionId, 'ses_main');
  assert.equal(s.title, 'refactor the parser', 'title comes from what the user typed');
  assert.equal(s.subagentSessions, 2);
  assert.equal(s.subagentTokens, 2 * TURN_TOKENS);
  // Nothing is lost and nothing is double-counted: 3 turns, 3 tools, 3x tokens.
  assert.equal(s.turnCount, 3);
  assert.equal(s.toolCount, 3);
  assert.equal(s.totalTokens, 3 * TURN_TOKENS);
  assert.equal(Number(s.cost.toFixed(4)), 0.03);
  // Merged turns stay in wall-clock order and helper turns are labelled.
  assert.deepEqual(s.turns.map((t) => t.timestamp), [...s.turns.map((t) => t.timestamp)].sort());
  assert.equal(s.turns[0].subagentSessionId, undefined);
  assert.equal(s.turns[1].subagentSessionId, 'ses_help1');
  assert.ok(s.turns[1].prompt.startsWith('↳ subagent:'));
  assert.ok(s.promptBreakdown.some((g) => g.prompt.startsWith('↳ subagent:')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rolls nested helpers all the way up to the top-level session', async () => {
  const dir = buildDb([
    { id: 'ses_main', prompt: 'ship the feature', at: 1000 },
    { id: 'ses_a', parentId: 'ses_main', title: 'helper', at: 2000 },
    { id: 'ses_b', parentId: 'ses_a', title: 'helper of a helper', at: 3000 },
  ]);
  const result = await adapter.parse({ home: dir });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].subagentSessions, 2);
  assert.equal(result.sessions[0].totalTokens, 3 * TURN_TOKENS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keeps a helper standalone when its parent row is gone', async () => {
  const dir = buildDb([{ id: 'ses_orphan', parentId: 'ses_deleted', prompt: 'do a thing', at: 1000 }]);
  const result = await adapter.parse({ home: dir });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].sessionId, 'ses_orphan');
  assert.equal(result.sessions[0].totalTokens, TURN_TOKENS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keeps a helper standalone when the parent itself recorded no turns', async () => {
  const dir = buildDb([
    { id: 'ses_empty', silent: true, at: 1000 },
    { id: 'ses_help', parentId: 'ses_empty', prompt: 'the only real work', at: 2000 },
  ]);
  const result = await adapter.parse({ home: dir });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].sessionId, 'ses_help');
  assert.equal(result.sessions[0].totalTokens, TURN_TOKENS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('survives a parent_id cycle without hanging or losing tokens', async () => {
  const dir = buildDb([
    { id: 'ses_x', parentId: 'ses_y', prompt: 'a', at: 1000 },
    { id: 'ses_y', parentId: 'ses_x', prompt: 'b', at: 2000 },
  ]);
  const result = await adapter.parse({ home: dir });
  const total = result.sessions.reduce((a, s) => a + s.totalTokens, 0);
  assert.equal(total, 2 * TURN_TOKENS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('treats every session as top-level on databases with no parent_id column', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-legacy-'));
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT,
      time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
  `);
  db.prepare('INSERT INTO session (id, directory, title, model, time_created, time_updated) VALUES (?,?,?,?,?,?)')
    .run('ses_old', '/tmp/proj', 'legacy', JSON.stringify({ modelID: 'claude-opus-5' }), 1000, 1100);
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)')
    .run('m1', 'ses_old', 1050, JSON.stringify({ role: 'assistant', modelID: 'claude-opus-5', cost: 0.01 }));
  db.prepare('INSERT INTO part (id, message_id, session_id, data) VALUES (?,?,?,?)')
    .run('p1', 'm1', 'ses_old', JSON.stringify(step(100, 100, 900)));
  db.close();

  const result = await adapter.parse({ home: dir });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].subagentSessions, 0);
  assert.equal(result.sessions[0].totalTokens, TURN_TOKENS);
  fs.rmSync(dir, { recursive: true, force: true });
});
