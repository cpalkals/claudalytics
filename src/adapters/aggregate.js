// Shared aggregation: turns normalized per-session data from any adapter into
// the single dashboard schema (daily/model/project/tool breakdowns + insights).
const { sum, fmt } = require('./shared');

function addMetric(target, source) {
  target.inputTokens += source.inputTokens || 0;
  target.cachedInputTokens += source.cachedInputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.reasoningOutputTokens += source.reasoningOutputTokens || 0;
  target.totalTokens += source.totalTokens || 0;
}

function groupTokenTotals(sessions, key) {
  const out = {};
  for (const session of sessions) {
    const value = session[key] || 'unknown';
    out[value] = (out[value] || 0) + session.totalTokens;
  }
  return out;
}

// Group a flat list of turns into prompt buckets (consecutive turns under the
// same user prompt), attaching per-prompt tool counts. Used by every adapter.
function buildPromptBreakdown(turns, toolEvents, fallbackTitle) {
  const promptKey = (prompt, fallback) => {
    const value = String(prompt || fallback || '(continuation)').trim();
    return value || '(continuation)';
  };
  const groups = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    current.totalTokens = current.turns.reduce((t, turn) => t + (turn.totalTokens || 0), 0);
    current.model = Object.entries(current.modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
    current.tools = Object.entries(current.toolCounts).map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count);
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
        key, prompt: key.slice(0, 700), firstTimestamp: turn.timestamp, lastTimestamp: turn.timestamp,
        turnIds: [], turnCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
        reasoningOutputTokens: 0, totalTokens: 0, maxTurnTokens: 0, model: 'unknown', modelCounts: {}, toolCounts: {}, turns: [],
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
      turnId: turn.turnId, timestamp: turn.timestamp, model: turn.model,
      inputTokens: turn.inputTokens, cachedInputTokens: turn.cachedInputTokens, outputTokens: turn.outputTokens,
      reasoningOutputTokens: turn.reasoningOutputTokens, totalTokens: turn.totalTokens, contextWindow: turn.contextWindow,
      tools: turn.tools, hasText: turn.hasText,
    });
  }
  flush();
  for (const toolEvent of toolEvents || []) {
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

function generateInsights(sessions, totals, largestTurns, topPrompts, weekdayUsage, caps) {
  const insights = [];
  if (sessions.length === 0) return insights;
  const agent = caps.label || 'the agent';

  const cachedPct = totals.totalTokens > 0 ? totals.cachedInputTokens / totals.totalTokens : 0;
  if (caps.cache && cachedPct > 0.35) {
    insights.push({
      type: 'info',
      title: `${Math.round(cachedPct * 100)}% of tokens came from cached input`,
      detail: `${agent} is reusing substantial context. That is usually good for continuity, but long threads can still grow expensive in raw token volume.`,
      action: 'Cached context is cheaper than fresh reads, so this is mostly healthy. The lever that still matters is thread length — a fresh thread resets the context carried forward.',
    });
  }

  if (caps.cost && totals.totalCost > 0) {
    insights.push({
      type: 'info',
      title: `Estimated API-equivalent spend: $${totals.totalCost.toFixed(2)}`,
      detail: `Across ${fmt(totals.totalTokens)} tokens. This is an API-rate estimate, not your subscription bill — useful for comparing where tokens (and cost) concentrate.`,
      action: 'Sort the sessions and prompts tables by tokens to find the few threads driving most of the estimated cost.',
    });
  }

  const reasoningPct = totals.outputTokens > 0 ? totals.reasoningOutputTokens / totals.outputTokens : 0;
  if (caps.reasoning && totals.reasoningOutputTokens > 0 && reasoningPct > 0.4) {
    insights.push({
      type: 'neutral',
      title: `${Math.round(reasoningPct * 100)}% of output tokens were reasoning, not final answers`,
      detail: `${agent} spent ${fmt(totals.reasoningOutputTokens)} tokens thinking versus ${fmt(totals.outputTokens - totals.reasoningOutputTokens)} tokens writing visible replies.`,
      action: 'Higher reasoning effort helps on hard problems but costs tokens on simple ones. Lower the reasoning effort for routine edits and questions.',
    });
  }

  const contextPressured = sessions.filter((s) => s.contextWindow && s.peakInputTokens && s.peakInputTokens / s.contextWindow >= 0.8);
  if (contextPressured.length >= 3) {
    insights.push({
      type: 'warning',
      title: `${contextPressured.length} sessions filled 80%+ of the context window`,
      detail: 'When the context window gets close to full, the agent spends more tokens carrying history forward, and older details can be summarized away.',
      action: 'Start a fresh session for a new task instead of continuing a near-full thread. Paste a short summary into the first message to preserve what matters.',
    });
  }

  const outputPct = totals.totalTokens > 0 ? totals.outputTokens / totals.totalTokens : 0;
  if (outputPct < 0.05 && totals.totalTokens > 0) {
    insights.push({
      type: 'neutral',
      title: `${(outputPct * 100).toFixed(1)}% of tokens were visible output`,
      detail: 'Most usage is the agent reading context, tool results, instructions, and prior conversation rather than writing final answers.',
      action: 'Because reading dominates, keeping threads short and pointing the agent at specific files matters far more than asking for shorter answers.',
    });
  }

  const longSessions = sessions.filter((session) => session.turnCount >= 50);
  if (longSessions.length > 0) {
    const longTokens = longSessions.reduce((s, ses) => s + ses.totalTokens, 0);
    insights.push({
      type: 'warning',
      title: `${longSessions.length} long session${longSessions.length === 1 ? '' : 's'} crossed 50 turns`,
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
      action: 'Single huge turns usually mean the agent re-read a very full context. Breaking the work into smaller asks keeps each turn cheaper.',
    });
  }

  const shortExpensive = topPrompts.filter((prompt) => prompt.prompt.length < 40 && prompt.totalTokens > 100000);
  if (shortExpensive.length > 0) {
    insights.push({
      type: 'warning',
      title: `${shortExpensive.length} short prompt${shortExpensive.length === 1 ? '' : 's'} used 100K+ tokens`,
      detail: 'Short follow-ups can still be expensive because the agent may be re-reading the full thread, tool output, and workspace context.',
      action: 'Be specific even on follow-ups. "Yes, update auth.js and run the tests" gives a target so the agent spends fewer turns figuring out what you meant.',
    });
  }

  const toolHeavy = sessions.filter((s) => s.promptCount > 0 && s.toolCount > s.promptCount * 4);
  if (caps.tools && toolHeavy.length >= 3) {
    const toolTokens = toolHeavy.reduce((s, ses) => s + ses.totalTokens, 0);
    insights.push({
      type: 'info',
      title: `${toolHeavy.length} sessions ran 4x+ more tool calls than prompts`,
      detail: `These tool-heavy sessions used ${fmt(toolTokens)} tokens. Every tool call (reading files, running commands) is a round trip that re-reads the thread.`,
      action: 'Point the agent at exact files and lines when you can. "Fix the bug in src/auth.js:42" triggers fewer searches than "fix the login bug".',
    });
  }

  const multiTurnPrompts = topPrompts.filter((prompt) => prompt.turnCount >= 5);
  if (multiTurnPrompts.length > 0) {
    insights.push({
      type: 'info',
      title: `${multiTurnPrompts.length} costly prompt${multiTurnPrompts.length === 1 ? '' : 's'} triggered multiple turns`,
      detail: 'These prompts likely caused tool-heavy work. Drill into a session to see how much each prompt and continuation consumed.',
      action: 'Open one of these in the session view to see exactly which continuation turns spent the tokens.',
    });
  }

  if (weekdayUsage.length >= 3) {
    const ranked = [...weekdayUsage].filter((d) => d.sessions > 0).sort((a, b) => b.avgTokens - a.avgTokens);
    if (ranked.length >= 2) {
      const busiest = ranked[0];
      const quietest = ranked[ranked.length - 1];
      insights.push({
        type: 'neutral',
        title: `You use ${agent} most on ${busiest.name}s`,
        detail: `${busiest.name} sessions average ${fmt(busiest.avgTokens)} tokens each, versus ${fmt(quietest.avgTokens)} on ${quietest.name}s.`,
        action: null,
      });
    }
  }

  const latestRate = sessions.find((session) => session.rateLimit)?.rateLimit;
  if (caps.rateLimit && latestRate?.primaryUsedPercent != null && latestRate.primaryUsedPercent >= 80) {
    insights.push({
      type: 'warning',
      title: `Primary limit is ${latestRate.primaryUsedPercent}% used`,
      detail: 'The latest local rate-limit event is near exhaustion for the current 5-hour window.',
      action: 'You are close to the cap. Heavy, long-context sessions burn the window fastest — defer big runs until it resets, shown in the limits panel.',
    });
  }

  return insights;
}

// Insert zero-token entries for calendar days with no sessions, so chart bars are
// spaced by real elapsed time instead of by index — otherwise a big spike on a day
// that falls between two sparse days can end up unlabeled and visually misplaced.
function fillDailyGaps(days) {
  if (days.length < 2) return days;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const [y0, m0, d0] = days[0].date.split('-').map(Number);
  const [y1, m1, d1] = days[days.length - 1].date.split('-').map(Number);
  const cursor = new Date(Date.UTC(y0, m0 - 1, d0));
  const end = Date.UTC(y1, m1 - 1, d1);
  const filled = [];
  while (cursor.getTime() <= end) {
    const date = cursor.toISOString().slice(0, 10);
    filled.push(byDate.get(date) || {
      date, sessions: 0, turns: 0, toolCalls: 0,
      inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return filled;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// sessions: normalized session objects. source/capabilities: adapter metadata.
function buildResult(sessions, source, capabilities, warnings = []) {
  const caps = { label: source.label, ...capabilities };
  sessions.sort((a, b) => (b.updatedTimestamp || '').localeCompare(a.updatedTimestamp || ''));

  const dailyMap = {}, weekdayMap = {}, modelMap = {}, projectMap = {}, toolMap = {};
  const largestTurns = [], topPrompts = [];
  const totals = {
    totalSessions: sessions.length, totalTurns: 0, totalPrompts: 0, totalToolCalls: 0,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
    totalCost: 0, avgTokensPerTurn: 0, avgTokensPerSession: 0, dateRange: null, latestRateLimit: null,
  };

  for (const session of sessions) {
    totals.totalTurns += session.turnCount;
    totals.totalPrompts += session.promptCount;
    totals.totalToolCalls += session.toolCount;
    totals.totalCost += session.cost || 0;
    addMetric(totals, session);

    if (!dailyMap[session.date]) dailyMap[session.date] = { date: session.date, sessions: 0, turns: 0, toolCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    dailyMap[session.date].sessions += 1;
    dailyMap[session.date].turns += session.turnCount;
    dailyMap[session.date].toolCalls += session.toolCount;
    addMetric(dailyMap[session.date], session);

    if (session.timestamp) {
      const wd = new Date(session.timestamp).getDay();
      if (!weekdayMap[wd]) weekdayMap[wd] = { weekday: wd, sessions: 0, totalTokens: 0 };
      weekdayMap[wd].sessions += 1;
      weekdayMap[wd].totalTokens += session.totalTokens;
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

    for (const [tool, count] of Object.entries(session.toolCounts || {})) {
      if (!toolMap[tool]) toolMap[tool] = { tool, count: 0 };
      toolMap[tool].count += count;
    }

    for (const turn of session.turns) {
      largestTurns.push({
        sessionId: session.sessionId, title: session.title, project: session.project, timestamp: turn.timestamp, model: turn.model,
        prompt: turn.prompt ? String(turn.prompt).slice(0, 260) : session.title,
        inputTokens: turn.inputTokens, cachedInputTokens: turn.cachedInputTokens, outputTokens: turn.outputTokens,
        reasoningOutputTokens: turn.reasoningOutputTokens, totalTokens: turn.totalTokens,
      });
    }
    for (const prompt of session.promptBreakdown) {
      topPrompts.push({
        sessionId: session.sessionId, title: session.title, project: session.project, date: session.date,
        timestamp: prompt.firstTimestamp, model: prompt.model, prompt: prompt.prompt, turnCount: prompt.turnCount,
        inputTokens: prompt.inputTokens, cachedInputTokens: prompt.cachedInputTokens, outputTokens: prompt.outputTokens,
        reasoningOutputTokens: prompt.reasoningOutputTokens, totalTokens: prompt.totalTokens, maxTurnTokens: prompt.maxTurnTokens, tools: prompt.tools,
      });
    }
    if (session.rateLimit) totals.latestRateLimit = session.rateLimit;
  }

  const dailyUsage = fillDailyGaps(Object.values(dailyMap).filter((d) => d.date !== 'unknown').sort((a, b) => a.date.localeCompare(b.date)));
  const weekdayUsage = Object.values(weekdayMap)
    .map((w) => ({ ...w, name: WEEKDAYS[w.weekday], avgTokens: w.sessions ? Math.round(w.totalTokens / w.sessions) : 0 }))
    .sort((a, b) => a.weekday - b.weekday);
  totals.avgTokensPerTurn = totals.totalTurns > 0 ? Math.round(totals.totalTokens / totals.totalTurns) : 0;
  totals.avgTokensPerSession = totals.totalSessions > 0 ? Math.round(totals.totalTokens / totals.totalSessions) : 0;
  totals.dateRange = dailyUsage.length ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date } : null;

  largestTurns.sort((a, b) => b.totalTokens - a.totalTokens);
  topPrompts.sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    source, capabilities,
    sessions, dailyUsage, weekdayUsage,
    modelBreakdown: Object.values(modelMap).sort((a, b) => b.totalTokens - a.totalTokens),
    projectBreakdown: Object.values(projectMap).sort((a, b) => b.totalTokens - a.totalTokens),
    toolBreakdown: Object.values(toolMap).sort((a, b) => b.count - a.count),
    largestTurns: largestTurns.slice(0, 30),
    topPrompts: topPrompts.slice(0, 50),
    insights: generateInsights(sessions, totals, largestTurns, topPrompts, weekdayUsage, caps),
    totals, warnings,
  };
}

function emptyResult(source, capabilities, warnings) {
  return {
    source, capabilities,
    sessions: [], dailyUsage: [], weekdayUsage: [], modelBreakdown: [], projectBreakdown: [], toolBreakdown: [],
    largestTurns: [], topPrompts: [], insights: [],
    totals: {
      totalSessions: 0, totalTurns: 0, totalPrompts: 0, totalToolCalls: 0,
      inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
      totalCost: 0, avgTokensPerTurn: 0, avgTokensPerSession: 0, dateRange: null, latestRateLimit: null,
    },
    warnings,
  };
}

module.exports = { buildResult, emptyResult, buildPromptBreakdown };
