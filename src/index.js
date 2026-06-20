#!/usr/bin/env node

const { createServer } = require('./server');

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || null;
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
agent-spend - See where your coding-agent tokens go

Auto-detects local usage for Codex, Claude Code, Qwen Code and Gemini CLI,
and lets you switch between them in the dashboard. All data stays local.

Usage:
  agent-spend [options]

Options:
  --port <port>          Port to run dashboard on (default: 3457)
  --codex-home <path>    Override Codex home (default: CODEX_HOME or ~/.codex)
  --no-open              Do not auto-open the browser
  --help, -h             Show this help message

Per-agent homes can also be set via env: CODEX_HOME, CLAUDE_HOME,
QWEN_HOME, GEMINI_HOME.

Examples:
  agent-spend
  agent-spend --port 8080
  agent-spend --codex-home ~/.codex --no-open
`);
  process.exit(0);
}

const port = parseInt(readOption(args, '--port') || '3457', 10);
const codexHome = readOption(args, '--codex-home') || process.env.CODEX_HOME || null;
const noOpen = args.includes('--no-open');

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('Error: --port must be a valid port number');
  process.exit(1);
}

const app = createServer({ codexHome });

const server = app.listen(port, async () => {
  const url = `http://localhost:${port}`;
  console.log(`\n  agent-spend dashboard running at ${url}\n`);

  if (!noOpen) {
    try {
      const open = (await import('open')).default;
      await open(url);
    } catch {
      console.log('  Could not auto-open browser. Open the URL manually.');
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try --port <other-port>`);
    process.exit(1);
  }
  throw err;
});

process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  server.close();
  process.exit(0);
});
