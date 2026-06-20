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

function getCodexHome(options = {}) {
  return expandHome(options.codexHome || process.env.CODEX_HOME) || path.join(os.homedir(), '.codex');
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
      // Keep going. A single bad line should not hide the rest of the dashboard.
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

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (typeof block === 'string') return block;
    return block.text || block.message || '';
  }).filter(Boolean).join('\n');
}

function isHumanPrompt(text) {
  if (!text) return false;
  const value = String(text).trim();
  if (!value) return false;
  if (value.startsWith('<environment_context>')) return false;
  if (value.startsWith('The following is the Codex agent history')) return false;
  if (value.startsWith('Continue the same review conversation')) return false;
  if (value.startsWith('You are reviewing an already-completed Codex turn')) return false;
  return true;
}

function projectFromCwd(cwd) {
  if (!cwd) return 'unknown';
  const home = os.homedir();
  let label = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const parts = label.split(path.sep).filter(Boolean);
  if (parts.length <= 2) return label || 'unknown';
  return parts.slice(-2).join(path.sep);
}

function extractSessionId(filePath, metaId) {
  if (metaId) return metaId;
  const base = path.basename(filePath, '.jsonl');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  return match ? match[1] : base;
}

function tokenUsageFromPayload(payload) {
  if (!payload || payload.type !== 'token_count') return null;
  const info = payload.info || {};
  const last = info.last_token_usage || {};
  const total = info.total_token_usage || {};
  return {
    inputTokens: last.input_tokens || 0,
    cachedInputTokens: last.cached_input_tokens || 0,
    outputTokens: last.output_tokens || 0,
    reasoningOutputTokens: last.reasoning_output_tokens || 0,
    totalTokens: last.total_tokens || 0,
    cumulativeTokens: total.total_tokens || 0,
    cumulativeInputTokens: total.input_tokens || 0,
    cumulativeCachedInputTokens: total.cached_input_tokens || 0,
    cumulativeOutputTokens: total.output_tokens || 0,
    cumulativeReasoningOutputTokens: total.reasoning_output_tokens || 0,
    contextWindow: info.model_context_window || null,
    rateLimits: payload.rate_limits || null,
  };
}

function latestRateLimit(rateLimits, previous) {
  if (!rateLimits) return previous || null;
  return {
    planType: rateLimits.plan_type || previous?.planType || null,
    limitId: rateLimits.limit_id || previous?.limitId || null,
    primaryUsedPercent: rateLimits.primary?.used_percent ?? previous?.primaryUsedPercent ?? null,
    primaryWindowMinutes: rateLimits.primary?.window_minutes ?? previous?.primaryWindowMinutes ?? null,
    primaryResetsAt: rateLimits.primary?.resets_at ?? previous?.primaryResetsAt ?? null,
    secondaryUsedPercent: rateLimits.secondary?.used_percent ?? previous?.secondaryUsedPercent ?? null,
    secondaryWindowMinutes: rateLimits.secondary?.window_minutes ?? previous?.secondaryWindowMinutes ?? null,
    secondaryResetsAt: rateLimits.secondary?.resets_at ?? previous?.secondaryResetsAt ?? null,
    reachedType: rateLimits.rate_limit_reached_type || previous?.reachedType || null,
  };
}

function extractSessionData(entries, filePath, titleMap, promptMap) {
  let meta = {};
  let model = 'unknown';
  let currentUserPrompt = null;
  let currentTurnId = null;
  let latestRate = null;
  const turns = [];
  const toolCounts = {};
  const toolEvents = [];
  let agentMessages = 0;

  for (const entry of entries) {
    const payload = entry.payload || {};

    if (entry.type === 'session_meta') {
      meta = payload;
      model = payload.model || model;
      continue;
    }

    if (entry.type === 'turn_context') {
      currentTurnId = payload.turn_id || currentTurnId;
      model = payload.model || model;
      continue;
    }

    if (payload.type === 'user_message') {
      if (isHumanPrompt(payload.message)) currentUserPrompt = payload.message;
      currentTurnId = payload.turn_id || currentTurnId;
      continue;
    }

    if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const text = textFromContent(payload.content);
      if (isHumanPrompt(text)) currentUserPrompt = text;
      continue;
    }

    if (entry.type === 'response_item' && payload.type === 'function_call') {
      const name = payload.name || 'tool';
      toolCounts[name] = (toolCounts[name] || 0) + 1;
      toolEvents.push({
        name,
        timestamp: entry.timestamp,
        prompt: currentUserPrompt || null,
        turnId: currentTurnId || null,
      });
      continue;
    }

    if (payload.type === 'agent_message') {
      agentMessages += 1;
      continue;
    }

    const usage = tokenUsageFromPayload(payload);
    if (usage) {
      latestRate = latestRateLimit(usage.rateLimits, latestRate);
      turns.push({
        turnId: payload.turn_id || currentTurnId || `turn-${turns.length + 1}`,
        timestamp: entry.timestamp,
        prompt: currentUserPrompt || null,
        model,
        ...usage,
      });
    }
  }

  const sessionId = extractSessionId(filePath, meta.id);
  if (turns.length === 0 && agentMessages === 0 && Object.keys(toolCounts).length === 0) return null;

  const lastTurn = turns[turns.length - 1] || {};
  const peakInputTokens = turns.reduce((max, t) => Math.max(max, t.inputTokens || 0), 0);
  const peakTurnTokens = turns.reduce((max, t) => Math.max(max, t.totalTokens || 0), 0);
  const firstTimestamp = meta.timestamp || entries.find((e) => e.timestamp)?.timestamp || null;
  const updatedTimestamp = entries.slice().reverse().find((e) => e.timestamp)?.timestamp || firstTimestamp;
  const date = firstTimestamp ? firstTimestamp.split('T')[0] : 'unknown';
  const titleCandidate = titleMap[sessionId];
  const historyPrompt = promptMap[sessionId];
  const title = (isHumanPrompt(titleCandidate) && titleCandidate)
    || (isHumanPrompt(historyPrompt) && historyPrompt)
    || (isHumanPrompt(currentUserPrompt) && currentUserPrompt)
    || '(untitled Codex session)';
  const project = projectFromCwd(meta.cwd || entries.find((e) => e.payload?.cwd)?.payload.cwd);
  const promptBreakdown = buildPromptBreakdown(turns, toolEvents, title);

  return {
    sessionId,
    filePath,
    archived: filePath.includes(`${path.sep}archived_sessions${path.sep}`),
    title: String(title).slice(0, 240),
    project,
    cwd: meta.cwd || null,
    date,
    timestamp: firstTimestamp,
    updatedTimestamp,
    model,
    turnCount: turns.length,
    agentMessages,
    toolCount: Object.values(toolCounts).reduce((sum, n) => sum + n, 0),
    toolCounts,
    promptCount: promptBreakdown.length,
    promptBreakdown,
    turns,
    inputTokens: lastTurn.cumulativeInputTokens || sum(turns, 'inputTokens'),
    cachedInputTokens: lastTurn.cumulativeCachedInputTokens || sum(turns, 'cachedInputTokens'),
    outputTokens: lastTurn.cumulativeOutputTokens || sum(turns, 'outputTokens'),
    reasoningOutputTokens: lastTurn.cumulativeReasoningOutputTokens || sum(turns, 'reasoningOutputTokens'),
    totalTokens: lastTurn.cumulativeTokens || sum(turns, 'totalTokens'),
    contextWindow: lastTurn.contextWindow || null,
    peakInputTokens,
    peakTurnTokens,
    rateLimit: latestRate,
  };
}

function promptKey(prompt, fallback) {
  const value = String(prompt || fallback || '(continuation)').trim();
  return value || '(continuation)';
}

function buildPromptBreakdown(turns, toolEvents, fallbackTitle) {
  const groups = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    current.totalTokens = current.turns.reduce((total, turn) => total + (turn.totalTokens || 0), 0);
    current.model = Object.entries(current.modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
    current.tools = Object.entries(current.toolCounts)
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count);
    delete current.modelCounts;
    delete current.toolCounts;
    groups.push(current);
    current = null;
  };

  for (const turn of turns) {
    const key = promptKey(turn.prompt, fallbackTitle);
    if (!current || current.key !== key) {
      flush();
      current = {
        key,
        prompt: key.slice(0, 700),
        firstTimestamp: turn.timestamp,
        lastTimestamp: turn.timestamp,
        turnIds: [],
        turnCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        maxTurnTokens: 0,
        model: 'unknown',
        modelCounts: {},
        toolCounts: {},
        turns: [],
      };
    }

    current.lastTimestamp = turn.timestamp || current.lastTimestamp;
    current.turnIds.push(turn.turnId);
    current.turnCount += 1;
    current.inputTokens += turn.inputTokens || 0;
    current.cachedInputTokens += turn.cachedInputTokens || 0;
    current.outputTokens += turn.outputTokens || 0;
    current.reasoningOutputTokens += turn.reasoningOutputTokens || 0;
    current.maxTurnTokens = Math.max(current.maxTurnTokens, turn.totalTokens || 0);
    if (turn.model) current.modelCounts[turn.model] = (current.modelCounts[turn.model] || 0) + 1;
    current.turns.push({
      turnId: turn.turnId,
      timestamp: turn.timestamp,
      model: turn.model,
      inputTokens: turn.inputTokens,
      cachedInputTokens: turn.cachedInputTokens,
      outputTokens: turn.outputTokens,
      reasoningOutputTokens: turn.reasoningOutputTokens,
      totalTokens: turn.totalTokens,
      contextWindow: turn.contextWindow,
    });
  }
  flush();

  for (const toolEvent of toolEvents) {
    const key = promptKey(toolEvent.prompt, fallbackTitle);
    const group = groups.find((item) => item.key === key);
    if (!group) continue;
    const existing = group.tools.find((tool) => tool.tool === toolEvent.name);
    if (existing) existing.count += 1;
    else group.tools.push({ tool: toolEvent.name, count: 1 });
    group.tools.sort((a, b) => b.count - a.count);
  }

  return groups.map(({ key, ...group }, index) => ({ rank: index + 1, ...group }));
}

function sum(items, key) {
  return items.reduce((total, item) => total + (item[key] || 0), 0);
}

function fmt(n) {
  n = Number(n || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return Math.round(n / 1000) + 'K';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function addMetric(target, source) {
  target.inputTokens += source.inputTokens || 0;
  target.cachedInputTokens += source.cachedInputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.reasoningOutputTokens += source.reasoningOutputTokens || 0;
  target.totalTokens += source.totalTokens || 0;
}

function generateInsights(sessions, totals, largestTurns, topPrompts, weekdayUsage = []) {
  const insights = [];
  if (sessions.length === 0) return insights;

  const cachedPct = totals.totalTokens > 0 ? totals.cachedInputTokens / totals.totalTokens : 0;
  if (cachedPct > 0.35) {
    insights.push({
      type: 'info',
      title: `${Math.round(cachedPct * 100)}% of tokens came from cached input`,
      detail: 'Codex is reusing substantial context. That is usually good for continuity, but long threads can still grow expensive in raw token volume.',
      action: 'Cached context is cheaper than fresh reads, so this is mostly healthy. The lever that still matters is thread length — a fresh thread resets the context Codex must carry forward.',
    });
  }

  const reasoningPct = totals.outputTokens > 0 ? totals.reasoningOutputTokens / totals.outputTokens : 0;
  if (totals.reasoningOutputTokens > 0 && reasoningPct > 0.4) {
    insights.push({
      type: 'neutral',
      title: `${Math.round(reasoningPct * 100)}% of output tokens were reasoning, not final answers`,
      detail: `Codex spent ${fmt(totals.reasoningOutputTokens)} tokens thinking versus ${fmt(totals.outputTokens - totals.reasoningOutputTokens)} tokens writing visible replies.`,
      action: 'Higher reasoning effort helps on hard problems but costs tokens on simple ones. Lower the reasoning effort for routine edits and questions.',
    });
  }

  const contextPressured = sessions.filter((s) => s.contextWindow && s.peakInputTokens && s.peakInputTokens / s.contextWindow >= 0.8);
  if (contextPressured.length >= 3) {
    insights.push({
      type: 'warning',
      title: `${contextPressured.length} sessions filled 80%+ of the context window`,
      detail: 'When the context window gets close to full, Codex spends more tokens just carrying forward history, and older details can be summarized away.',
      action: 'Start a fresh session for a new task instead of continuing a near-full thread. Paste a short summary into the first message to preserve the context that matters.',
    });
  }

  const outputPct = totals.totalTokens > 0 ? totals.outputTokens / totals.totalTokens : 0;
  if (outputPct < 0.05 && totals.totalTokens > 0) {
    insights.push({
      type: 'neutral',
      title: `${(outputPct * 100).toFixed(1)}% of tokens were visible output`,
      detail: 'Most usage is Codex reading context, tool results, instructions, and prior conversation rather than writing final answers.',
      action: 'Because reading dominates, keeping threads short and pointing Codex at specific files matters far more than asking for shorter answers.',
    });
  }

  const longSessions = sessions.filter((session) => session.turnCount >= 50);
  if (longSessions.length > 0) {
    const longTokens = longSessions.reduce((s, ses) => s + ses.totalTokens, 0);
    insights.push({
      type: 'warning',
      title: `${longSessions.length} long session${longSessions.length === 1 ? '' : 's'} crossed 50 token-count turns`,
      detail: `These threads used ${fmt(longTokens)} tokens combined. Long sessions are often where context grows the most.`,
      action: 'When a session drifts into a new task, start a fresh thread. A handoff note (or CONTEXT.md) carries the important bits without the full history.',
    });
  }

  const topProject = Object.entries(groupTokenTotals(sessions, 'project')).sort((a, b) => b[1] - a[1])[0];
  if (topProject && topProject[1] / Math.max(totals.totalTokens, 1) >= 0.6) {
    insights.push({
      type: 'info',
      title: `${topProject[0]} dominates usage`,
      detail: `${topProject[0]} accounts for ${Math.round((topProject[1] / totals.totalTokens) * 100)}% of all parsed tokens.`,
      action: 'Not a problem by itself, but if this project runs long marathon threads, splitting them into focused sessions would shrink its footprint.',
    });
  }

  if (largestTurns[0] && largestTurns[0].totalTokens > 100000) {
    insights.push({
      type: 'warning',
      title: 'Your largest turn crossed 100K tokens',
      detail: `One turn alone used ${fmt(largestTurns[0].totalTokens)} tokens — likely a large context window, many tool outputs, or a long accumulated thread.`,
      action: 'Single huge turns usually mean Codex re-read a very full context. Breaking the work into smaller asks keeps each turn cheaper.',
    });
  }

  const shortExpensive = topPrompts.filter((prompt) => prompt.prompt.length < 40 && prompt.totalTokens > 100000);
  if (shortExpensive.length > 0) {
    insights.push({
      type: 'warning',
      title: `${shortExpensive.length} short prompt${shortExpensive.length === 1 ? '' : 's'} used 100K+ tokens`,
      detail: 'Short follow-ups can still be expensive because Codex may be re-reading the full thread, tool output, and workspace context.',
      action: 'Be specific even on follow-ups. "Yes, update auth.js and run the tests" gives Codex a target so it spends fewer turns figuring out what you meant.',
    });
  }

  const toolHeavy = sessions.filter((s) => s.promptCount > 0 && s.toolCount > s.promptCount * 4);
  if (toolHeavy.length >= 3) {
    const toolTokens = toolHeavy.reduce((s, ses) => s + ses.totalTokens, 0);
    insights.push({
      type: 'info',
      title: `${toolHeavy.length} sessions ran 4x+ more tool calls than prompts`,
      detail: `These tool-heavy sessions used ${fmt(toolTokens)} tokens. Every tool call (reading files, running commands) is a round trip that re-reads the thread.`,
      action: 'Point Codex at exact files and lines when you can. "Fix the bug in src/auth.js:42" triggers fewer searches than "fix the login bug".',
    });
  }

  const multiTurnPrompts = topPrompts.filter((prompt) => prompt.turnCount >= 5);
  if (multiTurnPrompts.length > 0) {
    insights.push({
      type: 'info',
      title: `${multiTurnPrompts.length} costly prompt${multiTurnPrompts.length === 1 ? '' : 's'} triggered multiple Codex turns`,
      detail: 'These prompts likely caused tool-heavy work. Drill into a session to see how much each prompt and continuation consumed.',
      action: 'Open one of these in the session view below to see exactly which continuation turns spent the tokens.',
    });
  }

  if (weekdayUsage.length >= 3) {
    const ranked = [...weekdayUsage].filter((d) => d.sessions > 0).sort((a, b) => b.avgTokens - a.avgTokens);
    if (ranked.length >= 2) {
      const busiest = ranked[0];
      const quietest = ranked[ranked.length - 1];
      insights.push({
        type: 'neutral',
        title: `You use Codex most on ${busiest.name}s`,
        detail: `${busiest.name} sessions average ${fmt(busiest.avgTokens)} tokens each, versus ${fmt(quietest.avgTokens)} on ${quietest.name}s.`,
        action: null,
      });
    }
  }

  const latestRate = sessions.find((session) => session.rateLimit)?.rateLimit;
  if (latestRate?.primaryUsedPercent != null && latestRate.primaryUsedPercent >= 80) {
    insights.push({
      type: 'warning',
      title: `Primary Codex limit is ${latestRate.primaryUsedPercent}% used`,
      detail: 'The latest local rate-limit event is near exhaustion for the current 5-hour window.',
      action: 'You are close to the cap. Heavy, long-context sessions burn the window fastest — defer big runs until it resets, shown in the limits panel above.',
    });
  }

  return insights;
}

function groupTokenTotals(sessions, key) {
  const out = {};
  for (const session of sessions) {
    const value = session[key] || 'unknown';
    out[value] = (out[value] || 0) + session.totalTokens;
  }
  return out;
}

async function parseAllSessions(options = {}) {
  const codexHome = getCodexHome(options);
  const warnings = [];

  if (!fs.existsSync(codexHome)) {
    return emptyResult(codexHome, [{ type: 'missing-dir', message: `Codex home not found at ${codexHome}` }]);
  }

  const titleMap = await readJSONLMap(
    path.join(codexHome, 'session_index.jsonl'),
    (entry) => entry.id,
    (entry) => entry.thread_name || entry.id
  );
  const promptMap = await readJSONLMap(
    path.join(codexHome, 'history.jsonl'),
    (entry) => entry.session_id,
    (entry) => entry.text
  );

  const files = [
    ...walkJSONL(path.join(codexHome, 'sessions')),
    ...walkJSONL(path.join(codexHome, 'archived_sessions')),
  ];

  if (files.length === 0) {
    return emptyResult(codexHome, [{ type: 'no-sessions', message: 'No Codex session JSONL files found.' }]);
  }

  const sessions = [];
  for (const filePath of files) {
    let entries;
    try {
      entries = await parseJSONLFile(filePath);
    } catch (err) {
      warnings.push({ type: 'read-failed', message: `Could not read ${filePath}: ${err.message}` });
      continue;
    }
    const session = extractSessionData(entries, filePath, titleMap, promptMap);
    if (session) sessions.push(session);
  }

  sessions.sort((a, b) => (b.updatedTimestamp || '').localeCompare(a.updatedTimestamp || ''));

  const dailyMap = {};
  const weekdayMap = {};
  const modelMap = {};
  const projectMap = {};
  const toolMap = {};
  const largestTurns = [];
  const topPrompts = [];
  const totals = {
    totalSessions: sessions.length,
    totalTurns: 0,
    totalPrompts: 0,
    totalToolCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    avgTokensPerTurn: 0,
    avgTokensPerSession: 0,
    dateRange: null,
    latestRateLimit: null,
  };

  for (const session of sessions) {
    totals.totalTurns += session.turnCount;
    totals.totalPrompts += session.promptCount;
    totals.totalToolCalls += session.toolCount;
    addMetric(totals, session);

    if (!dailyMap[session.date]) {
      dailyMap[session.date] = { date: session.date, sessions: 0, turns: 0, toolCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    }
    dailyMap[session.date].sessions += 1;
    dailyMap[session.date].turns += session.turnCount;
    dailyMap[session.date].toolCalls += session.toolCount;
    addMetric(dailyMap[session.date], session);

    if (session.timestamp) {
      const weekday = new Date(session.timestamp).getDay();
      if (!weekdayMap[weekday]) weekdayMap[weekday] = { weekday, sessions: 0, totalTokens: 0 };
      weekdayMap[weekday].sessions += 1;
      weekdayMap[weekday].totalTokens += session.totalTokens;
    }

    const model = session.model || 'unknown';
    if (!modelMap[model]) modelMap[model] = { model, sessions: 0, turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    modelMap[model].sessions += 1;
    modelMap[model].turns += session.turnCount;
    addMetric(modelMap[model], session);

    const project = session.project || 'unknown';
    if (!projectMap[project]) projectMap[project] = { project, sessions: 0, turns: 0, toolCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    projectMap[project].sessions += 1;
    projectMap[project].turns += session.turnCount;
    projectMap[project].toolCalls += session.toolCount;
    addMetric(projectMap[project], session);

    for (const [tool, count] of Object.entries(session.toolCounts)) {
      if (!toolMap[tool]) toolMap[tool] = { tool, count: 0 };
      toolMap[tool].count += count;
    }

    for (const turn of session.turns) {
      largestTurns.push({
        sessionId: session.sessionId,
        title: session.title,
        project: session.project,
        timestamp: turn.timestamp,
        model: turn.model,
        prompt: turn.prompt ? String(turn.prompt).slice(0, 260) : session.title,
        inputTokens: turn.inputTokens,
        cachedInputTokens: turn.cachedInputTokens,
        outputTokens: turn.outputTokens,
        reasoningOutputTokens: turn.reasoningOutputTokens,
        totalTokens: turn.totalTokens,
      });
    }

    for (const prompt of session.promptBreakdown) {
      topPrompts.push({
        sessionId: session.sessionId,
        title: session.title,
        project: session.project,
        date: session.date,
        timestamp: prompt.firstTimestamp,
        model: prompt.model,
        prompt: prompt.prompt,
        turnCount: prompt.turnCount,
        inputTokens: prompt.inputTokens,
        cachedInputTokens: prompt.cachedInputTokens,
        outputTokens: prompt.outputTokens,
        reasoningOutputTokens: prompt.reasoningOutputTokens,
        totalTokens: prompt.totalTokens,
        maxTurnTokens: prompt.maxTurnTokens,
        tools: prompt.tools,
      });
    }

    if (session.rateLimit) totals.latestRateLimit = session.rateLimit;
  }

  const dailyUsage = Object.values(dailyMap).filter((d) => d.date !== 'unknown').sort((a, b) => a.date.localeCompare(b.date));
  const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekdayUsage = Object.values(weekdayMap)
    .map((w) => ({ ...w, name: weekdayNames[w.weekday], avgTokens: w.sessions ? Math.round(w.totalTokens / w.sessions) : 0 }))
    .sort((a, b) => a.weekday - b.weekday);
  totals.avgTokensPerTurn = totals.totalTurns > 0 ? Math.round(totals.totalTokens / totals.totalTurns) : 0;
  totals.avgTokensPerSession = totals.totalSessions > 0 ? Math.round(totals.totalTokens / totals.totalSessions) : 0;
  totals.dateRange = dailyUsage.length ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date } : null;

  largestTurns.sort((a, b) => b.totalTokens - a.totalTokens);
  topPrompts.sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    codexHome,
    sessions,
    dailyUsage,
    weekdayUsage,
    modelBreakdown: Object.values(modelMap).sort((a, b) => b.totalTokens - a.totalTokens),
    projectBreakdown: Object.values(projectMap).sort((a, b) => b.totalTokens - a.totalTokens),
    toolBreakdown: Object.values(toolMap).sort((a, b) => b.count - a.count),
    largestTurns: largestTurns.slice(0, 30),
    topPrompts: topPrompts.slice(0, 50),
    insights: generateInsights(sessions, totals, largestTurns, topPrompts, weekdayUsage),
    totals,
    warnings,
  };
}

function emptyResult(codexHome, warnings) {
  return {
    codexHome,
    sessions: [],
    dailyUsage: [],
    weekdayUsage: [],
    modelBreakdown: [],
    projectBreakdown: [],
    toolBreakdown: [],
    largestTurns: [],
    topPrompts: [],
    insights: [],
    totals: {
      totalSessions: 0,
      totalTurns: 0,
      totalPrompts: 0,
      totalToolCalls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      avgTokensPerTurn: 0,
      avgTokensPerSession: 0,
      dateRange: null,
      latestRateLimit: null,
    },
    warnings,
  };
}

module.exports = { parseAllSessions };
