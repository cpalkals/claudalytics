// Claude Code system-prompt TEMPLATE extraction — offline only.
//
// Claude Code does not persist the exact rendered per-session system prompt in
// its logs. What we *can* do, fully locally, is pull the source/template prompt
// pieces embedded in the installed Claude Code binary (a Bun-compiled ELF with
// minified JS + string literals). This is template/source material, NOT the
// final rendered prompt — the UI must say so.
//
// No network access, no vendored datasets: we only read the local binary.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const readline = require('readline');
const { clip } = require('./shared');

const WARNING = "Extracted from the local Claude Code binary. This is source/template prompt material, not the exact final rendered prompt sent for this session.";

// Cache the binary-derived extraction by sourcePath (extraction is the slow part;
// it depends only on the binary, not on the session).
const cache = new Map();

// Readable prompt-text sections we try to recover, best (longest) match wins.
const TEXT_SECTIONS = [
  { title: 'Identity', re: /You are Claude Code/, conf: 'high' },
  { title: 'Core role & behavior', re: /You are an interactive CLI tool/, conf: 'high' },
  { title: 'Tone and style', re: /(tone and style|minimize output tokens|be concise)/i, conf: 'medium' },
  { title: 'Memory & CLAUDE.md', re: /CLAUDE\.md/, conf: 'medium' },
  { title: 'System reminders', re: /<system-reminder>/, conf: 'medium' },
  { title: 'System-prompt CLI flags', re: /append-system-prompt|--system-prompt/, conf: 'low' },
];
// Assembly markers we only *detect the presence of* (their context is minified
// code, so we list the names rather than dumping JS).
const CODE_MARKERS = [
  'getSystemPrompt', 'defaultSystemPrompt', 'renderedSystemPrompt',
  'SYSTEM_PROMPT_DYNAMIC_BOUNDARY', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
  'CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE', 'CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT',
];
// Pre-filter pattern so `strings` output is reduced by grep before Node sees it.
const GREP_PATTERN = [
  'You are Claude Code', 'You are an interactive CLI tool', 'tone and style',
  'minimize output tokens', 'be concise', 'CLAUDE[.]md', '<system-reminder>',
  'append-system-prompt', '--system-prompt', ...CODE_MARKERS,
].join('|');

function versionsBase() { return path.join(os.homedir(), '.local', 'share', 'claude', 'versions'); }

// Prefer the exact installed version dir; else resolve `which claude`.
function findBinary(version) {
  if (version) {
    const p = path.join(versionsBase(), version);
    try { fs.accessSync(p, fs.constants.X_OK); return { path: p, sourceVersion: version }; } catch { /* not installed */ }
  }
  let which = null;
  try { which = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim(); } catch { /* not on PATH */ }
  if (!which) { const guess = path.join(os.homedir(), '.local', 'bin', 'claude'); if (fs.existsSync(guess)) which = guess; }
  if (which) {
    try {
      const real = fs.realpathSync(which);
      const base = path.basename(real);
      const sourceVersion = /^\d+\.\d+\.\d+/.test(base) ? base : null;
      return { path: real, sourceVersion };
    } catch { /* dangling */ }
  }
  return null;
}

function readableScore(s) { const m = s.match(/[A-Za-z0-9 ,.'"\-:()/]/g); return (m ? m.length : 0) / s.length; }
// Reject minified JS so we keep prompt prose, not surrounding code.
function looksLikeCode(s) {
  return /=>|function |\breturn |\bvar |\bconst |\blet |\)\s*\{|\}\s*\(|;[A-Za-z$]|\$\{|`\)|\(["'`]|\}\)/.test(s);
}
function isReadable(s) { return s.length >= 40 && s.length <= 4000 && readableScore(s) >= 0.9 && !looksLikeCode(s); }

function classify(line, best, found) {
  for (const m of CODE_MARKERS) if (line.includes(m)) found.add(m);
  if (!isReadable(line)) return;
  for (const sec of TEXT_SECTIONS) {
    if (sec.re.test(line)) {
      const cur = best[sec.title];
      if (!cur || line.length > cur.len) best[sec.title] = { content: line, len: line.length };
    }
  }
}

// Primary path: `strings -a BIN | grep -aE PATTERN`, classified line-by-line.
function scanWithStrings(binPath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    let strings, grep;
    try {
      strings = spawn('strings', ['-a', binPath]);
      grep = spawn('grep', ['-aE', GREP_PATTERN]);
    } catch (e) { return reject(e); }
    strings.on('error', reject); grep.on('error', reject);
    strings.stdout.on('error', () => {}); grep.stdin.on('error', () => {}); strings.stderr.resume(); grep.stderr.resume();
    strings.stdout.pipe(grep.stdin);
    const best = {}; const found = new Set();
    const rl = readline.createInterface({ input: grep.stdout });
    rl.on('line', (line) => classify(line, best, found));
    const to = setTimeout(() => { try { strings.kill('SIGKILL'); } catch {} try { grep.kill('SIGKILL'); } catch {} finish(resolve, { best, found }); }, 20000);
    rl.on('close', () => { clearTimeout(to); finish(resolve, { best, found }); });
  });
}

// Fallback when `strings` is unavailable: scan printable runs in Node.
function scanFallback(binPath) {
  return new Promise((resolve) => {
    const best = {}; const found = new Set();
    let tail = '';
    const stream = fs.createReadStream(binPath);
    stream.on('data', (buf) => {
      const s = tail + buf.toString('latin1');
      const runs = s.match(/[\x20-\x7e]{10,}/g) || [];
      for (const r of runs) classify(r, best, found);
      tail = s.slice(-128);
    });
    stream.on('end', () => resolve({ best, found }));
    stream.on('error', () => resolve({ best, found }));
  });
}

function buildSections(scan, bin) {
  const { best, found } = scan;
  const sections = [];
  for (const sec of TEXT_SECTIONS) {
    if (best[sec.title]) sections.push({ title: sec.title, content: clip(best[sec.title].content.trim(), 4000), source: 'local Claude Code binary (strings)', confidence: sec.conf });
  }
  if (found.size) sections.push({ title: 'Prompt-assembly markers present', content: [...found].sort().join('\n'), source: 'local Claude Code binary (symbol scan)', confidence: 'reference' });
  const idHigh = best.Identity && /Anthropic's official CLI/.test(best.Identity.content);
  const available = sections.some((s) => s.confidence !== 'reference');
  const confidence = !available ? 'none' : (idHigh ? 'high' : 'medium');
  return { sections, available, confidence, sourceVersion: bin.sourceVersion, sourcePath: bin.path };
}

async function extractForBinary(bin) {
  if (cache.has(bin.path)) return cache.get(bin.path);
  let scan;
  try { scan = await scanWithStrings(bin.path); }
  catch { try { scan = await scanFallback(bin.path); } catch { scan = { best: {}, found: new Set() }; } }
  const built = buildSections(scan, bin);
  cache.set(bin.path, built);
  return built;
}

function unavailable(message) {
  return { available: false, kind: 'unavailable', title: 'Claude Code system prompt template', version: null, sourceVersion: null, sourcePath: null, confidence: 'none', warning: message || WARNING, sections: [] };
}

// version: the Claude Code version recorded in the session's JSONL.
async function getPromptTemplate(version) {
  let bin;
  try { bin = findBinary(version); } catch { bin = null; }
  if (!bin) return unavailable('Claude Code binary not found locally, so the prompt template could not be extracted.');
  let built;
  try { built = await extractForBinary(bin); } catch (e) { return unavailable(`Prompt template extraction failed locally: ${e.message}`); }
  if (!built.available) return unavailable('No recognizable Claude Code prompt markers were found in the local binary, so no template could be extracted.');
  const mismatch = version && built.sourceVersion && version !== built.sourceVersion;
  const warning = WARNING + (mismatch ? ` Note: this session ran ${version}, which is not installed locally, so the template was extracted from ${built.sourceVersion}.` : '');
  return {
    available: true, kind: 'binary-template', title: 'Claude Code system prompt template',
    version: version || built.sourceVersion || null, sourceVersion: built.sourceVersion, sourcePath: built.sourcePath,
    confidence: built.confidence, warning, sections: built.sections,
  };
}

module.exports = { getPromptTemplate };
