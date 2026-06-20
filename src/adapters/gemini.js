// Gemini CLI adapter — detected for completeness, but Gemini's local chat logs
// are an event-sourced format that does not record per-turn token usage, so
// there is nothing to chart. Reported as detected-but-unsupported.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { expandHome } = require('./shared');
const { emptyResult } = require('./aggregate');

const id = 'gemini';
const label = 'Gemini CLI';
const mark = 'GE';
const accent = '#5a8fd6';
const capabilities = { cost: false, reasoning: false, rateLimit: false, cache: false, tools: false, contextWindow: false };

function home(options = {}) {
  return expandHome(options.home || process.env.GEMINI_HOME) || path.join(os.homedir(), '.gemini');
}
function detect(options = {}) {
  return fs.existsSync(path.join(home(options), 'tmp')) || fs.existsSync(path.join(home(options), 'history'));
}
async function parse(options = {}) {
  const h = home(options);
  return emptyResult({ id, label, mark, accent, home: h }, capabilities, [{
    type: 'no-token-data',
    message: 'Gemini CLI does not record per-turn token usage in its local logs, so there is nothing to chart yet.',
  }]);
}

module.exports = { id, label, mark, accent, capabilities, home, detect, parse };
