// Generic helpers shared by every agent adapter.
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

function expandHome(inputPath) {
  if (!inputPath) return null;
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

async function parseJSONLFile(filePath) {
  const entries = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A single bad line should not hide the rest of the dashboard.
    }
  }
  return entries;
}

async function readJSONLMap(filePath, getKey, getValue) {
  const map = {};
  if (!fs.existsSync(filePath)) return map;
  const entries = await parseJSONLFile(filePath);
  for (const entry of entries) {
    const key = getKey(entry);
    if (!key || map[key]) continue;
    map[key] = getValue(entry);
  }
  return map;
}

function walkJSONL(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const name of fs.readdirSync(dir)) {
    const filePath = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walkJSONL(filePath, files);
    else if (name.endsWith('.jsonl')) files.push(filePath);
  }
  return files;
}

// Calendar day in the machine's local timezone — NOT the UTC date. Splitting an
// ISO timestamp string (or calling toISOString()) gives the UTC day, which is a
// day ahead of local for anyone west of Greenwich once it's past ~7-8pm local.
function localDay(value) {
  if (!value) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    return block.text || block.message || '';
  }).filter(Boolean).join('\n');
}

function projectFromCwd(cwd) {
  if (!cwd) return 'unknown';
  const home = os.homedir();
  let label = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const parts = label.split(path.sep).filter(Boolean);
  if (parts.length <= 2) return label || 'unknown';
  return parts.slice(-2).join(path.sep);
}

function sum(items, key) {
  return items.reduce((total, item) => total + (item[key] || 0), 0);
}

// Trim a possibly-huge text blob so the content view stays light over the wire.
function clip(value, max = 8000) {
  const s = value == null ? '' : String(value);
  return s.length > max ? s.slice(0, max) + `\n…[truncated, ${s.length - max} more chars]` : s;
}

function safeParse(json) {
  try { return typeof json === 'string' ? JSON.parse(json) : (json || {}); } catch { return {}; }
}

function fmt(n) {
  n = Number(n || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return Math.round(n / 1000) + 'K';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString();
}

module.exports = { expandHome, parseJSONLFile, readJSONLMap, walkJSONL, textFromContent, projectFromCwd, sum, fmt, clip, safeParse, localDay };
