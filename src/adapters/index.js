// Agent adapter registry. Add new coding agents by dropping an adapter module
// here that exports { id, label, mark, accent, capabilities, home, detect, parse }.
const codex = require('./codex');
const claude = require('./claude');
const qwen = require('./qwen');
const gemini = require('./gemini');

const ADAPTERS = [codex, claude, qwen, gemini];

function list() {
  return ADAPTERS.map((a) => ({
    id: a.id, label: a.label, mark: a.mark, accent: a.accent,
    capabilities: a.capabilities, home: a.home(), available: a.detect(),
  }));
}

function get(sourceId) {
  return ADAPTERS.find((a) => a.id === sourceId) || null;
}

// First available adapter, preferring Codex, then anything detected.
function defaultSourceId() {
  const available = list().filter((s) => s.available);
  if (available.find((s) => s.id === 'codex')) return 'codex';
  return (available[0] || list()[0]).id;
}

module.exports = { list, get, defaultSourceId, ADAPTERS };
