const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const openrouter = require('../src/openrouter');
const { createServer } = require('../src/server');

const KEY_INFO = { label: 'sk-or-v1-au7...890', usage: 25.5, usage_daily: 1.5, usage_weekly: 7.25, usage_monthly: 25.5, is_management_key: false };

function isolate(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrascope-home-'));
  const savedHome = process.env.METRASCOPE_HOME;
  const savedEnvKey = process.env.OPENROUTER_API_KEY;
  const realFetch = global.fetch;
  process.env.METRASCOPE_HOME = dir;
  delete process.env.OPENROUTER_API_KEY;
  openrouter.clearKey();
  t.after(() => {
    openrouter.clearKey();
    global.fetch = realFetch;
    if (savedHome === undefined) delete process.env.METRASCOPE_HOME; else process.env.METRASCOPE_HOME = savedHome;
    if (savedEnvKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedEnvKey;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const stubOk = () => { global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: KEY_INFO }) }); };

test('a key typed in stays in memory and writes nothing to disk', async (t) => {
  const dir = isolate(t);
  stubOk();
  const res = await openrouter.setKey('sk-or-v1-typed');
  assert.equal(res.ok, true);
  assert.equal(res.saved, false);
  assert.equal(res.status.origin, 'session');
  assert.equal(res.status.masked, 'sk-or-v1…yped');
  assert.equal(fs.existsSync(path.join(dir, 'openrouter.json')), false, 'nothing persisted by default');
  assert.equal(openrouter.enabled(), true);
});

test('remember writes a 0600 file that survives a restart', async (t) => {
  const dir = isolate(t);
  stubOk();
  const res = await openrouter.setKey('sk-or-v1-remembered', { remember: true });
  assert.equal(res.saved, true);
  const file = path.join(dir, 'openrouter.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).key, 'sk-or-v1-remembered');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only');
  }
  // Simulate a restart: the in-memory key is gone, the file is not.
  openrouter._test.resetSession();
  assert.equal(openrouter.status().origin, 'saved');
  assert.equal(openrouter.status().remembered, true);
});

test('precedence is session key, then saved key, then the environment', async (t) => {
  isolate(t);
  stubOk();
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-fromenv';
  assert.equal(openrouter.status().origin, 'env', 'env is the fallback');
  assert.equal(openrouter.status().removable, false, 'an env key cannot be cleared from the UI');

  await openrouter.setKey('sk-or-v1-saved', { remember: true });
  openrouter._test.resetSession();
  assert.equal(openrouter.status().origin, 'saved', 'a saved key outranks the environment');

  await openrouter.setKey('sk-or-v1-session');
  assert.equal(openrouter.status().origin, 'session', 'this run outranks everything');
});

test('disconnect clears both the memory key and the saved file', async (t) => {
  const dir = isolate(t);
  stubOk();
  await openrouter.setKey('sk-or-v1-bye', { remember: true });
  const res = openrouter.clearKey();
  assert.equal(res.removed, true);
  assert.equal(res.status.configured, false);
  assert.equal(fs.existsSync(path.join(dir, 'openrouter.json')), false);
});

test('a malformed or rejected key is refused and does not become active', async (t) => {
  isolate(t);
  stubOk();
  const bad = await openrouter.setKey('hunter2');
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('sk-or-'));
  assert.equal(openrouter.enabled(), false, 'never became active');

  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const rejected = await openrouter.setKey('sk-or-v1-wrong');
  assert.equal(rejected.ok, false);
  assert.ok(rejected.error.includes('rejected'));
  assert.equal(openrouter.enabled(), false);
});

// --- HTTP surface ------------------------------------------------------------
async function withServer(t, fn) {
  const app = createServer({});
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  return fn(`http://127.0.0.1:${server.address().port}`);
}
const realFetchRef = global.fetch;

test('the key endpoints reject cross-site and header-less requests', async (t) => {
  isolate(t);
  await withServer(t, async (base) => {
    const send = (headers) => realFetchRef(`${base}/api/openrouter/key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ key: 'sk-or-v1-x' }),
    });
    assert.equal((await send({})).status, 403, 'no dashboard header');
    assert.equal((await send({ 'X-Metrascope': '1', Origin: 'https://evil.example' })).status, 403, 'foreign origin');
    assert.equal((await realFetchRef(`${base}/api/openrouter/key`, { method: 'DELETE' })).status, 403);
  });
});

test('status is readable without a key and never exposes the secret', async (t) => {
  isolate(t);
  global.fetch = async (url, init) => {
    if (String(url).includes('openrouter.ai')) return { ok: true, status: 200, json: async () => ({ data: KEY_INFO }) };
    return realFetchRef(url, init);
  };
  await withServer(t, async (base) => {
    const before = await (await global.fetch(`${base}/api/openrouter/key`)).json();
    assert.deepEqual({ configured: before.configured, origin: before.origin }, { configured: false, origin: null });

    const set = await global.fetch(`${base}/api/openrouter/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Metrascope': '1', Origin: `${base}` },
      body: JSON.stringify({ key: 'sk-or-v1-supersecret' }),
    });
    const body = await set.json();
    assert.equal(set.status, 200);
    assert.equal(body.status.origin, 'session');
    assert.ok(!JSON.stringify(body).includes('supersecret'), 'the raw key never comes back');

    const after = await (await global.fetch(`${base}/api/openrouter/key`)).json();
    assert.equal(after.configured, true);
    assert.ok(!JSON.stringify(after).includes('supersecret'));
  });
});
