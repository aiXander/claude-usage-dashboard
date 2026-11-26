import os from 'node:os';
import { parseTranscript } from './parse.mjs';
import { readDigest, writeDigest, archivedDigests } from './cache.mjs';
import { costOf, costParts, isPriced } from './pricing.mjs';
import path from 'node:path';
import { projectIndex, readLedgers, readHistory, isUnder, projectOf } from './discover.mjs';

// Local-time bucketing throughout: "when did I work" is a wall-clock question.
function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function bump(map, key, fields) {
  let row = map.get(key);
  if (!row) map.set(key, (row = {}));
  for (const k in fields) row[k] = (row[k] || 0) + fields[k];
  return row;
}

function median(sorted) {
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Inclusive list of every calendar day from `from` to `to`, as `YYYY-MM-DD`. */
function dayRange(from, to) {
  const out = [];
  if (!from || !to) return out;
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor <= end) {
    out.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Build the full report for a project root.
 *
 * Three data sources with different reach, deliberately kept distinct rather
 * than blended:
 *   - `.claude-costs` ledgers — exact per-session cost, all time, no timestamps
 *   - `~/.claude/projects/**
 * One session can span several transcript files: its subagents' files, and a
 * main thread resumed across files. They share a sessionId, and the ledger has
 * one total per sessionId, so merge them before reconciling — matching each
 * file to the full ledger total would rescale every part up to the whole.
 */
/**
 * Model of the last request at or before `ts` (messages are sorted). Digests
 * archived before turns carried their model fall back to this.
 */
function modelAt(messages, ts) {
  let lo = 0;
  let hi = messages.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].ts <= ts) {
      found = messages[mid].model;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found || messages[0]?.model || 'unknown';
}

function mergeBySession(digests) {
  const byId = new Map();
  const out = [];
  for (const d of digests) {
    if (!d.sessionId) {
      out.push(d);
      continue;
    }
    const into = byId.get(d.sessionId);
    if (!into) {
      const copy = { ...d, messages: [...d.messages], toolCounts: { ...d.toolCounts }, turnDurations: [...d.turnDurations] };
      byId.set(d.sessionId, copy);
      out.push(copy);
      continue;
    }
    into.messages.push(...d.messages);
    for (const [k, v] of Object.entries(d.toolCounts)) into.toolCounts[k] = (into.toolCounts[k] || 0) + v;
    into.turnDurations.push(...d.turnDurations);
    into.edits = [...(into.edits || []), ...(d.edits || [])];
    into.branches = [...new Set([...into.branches, ...d.branches])];
    into.versions = [...new Set([...into.versions, ...d.versions])];
    // A subagent file has no title of its own, so the main thread's wins.
    into.title ||= d.title;
    into.cwd ||= d.cwd;
    into.malformed += d.malformed;
  }
  for (const d of byId.values()) {
    d.messages.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    d.firstTs = d.messages.length ? d.messages[0].ts : null;
    d.lastTs = d.messages.length ? d.messages[d.messages.length - 1].ts : null;
  }
  return out;
}

/**.jsonl` — full token/tool/model detail, ~30d retention
 *   - `~/.claude/history.jsonl` — every prompt with a timestamp, ~all time
 * The token detail is exact but recent; the ledger is exact but undated; the
 * prompt history is the only thing that spans both. Anything needing all three
 * at once (the all-time cost curve) is labelled estimated.
 */
export async function analyze(root, onProgress = () => {}, { exclude = [] } = {}) {
  const startedAt = Date.now();
  const warnings = [];

  // Projects (see `projectOf`) are the unit of the project filter: a hidden
  // project's transcripts, ledger and prompts all drop out before anything is
  // counted, so every figure and the ledger reconciliation stay consistent.
  const hidden = new Set(exclude);
  const memo = new Map();
  const project = (cwd) => projectOf(cwd, root, memo);
  const shown = (cwd) => !hidden.has(project(cwd));

  const index = await projectIndex({ force: true });
  const allDirs = index.filter((p) => isUnder(p.cwd, root));
  const dirs = allDirs.filter((p) => shown(p.cwd));
  const files = dirs.flatMap((d) => d.files);

  const history = await readHistory();
  const sessionCwds = [...allDirs.map((d) => d.cwd), ...history.map((h) => h.project)];
  const { costs: ledger, files: ledgerFiles, byFile: ledgerByFile, unreadable } = await readLedgers(
    root,
    (file) => !hidden.has(path.dirname(file)),
    sessionCwds,
  );
  if (unreadable.length) {
    warnings.push(`${unreadable.length} cost ledger(s) could not be parsed and were skipped.`);
  }

  const rootHistory = history.filter((row) => isUnder(row.project, root));
  const projectHistory = rootHistory.filter((row) => shown(row.project));

  // ---------------------------------------------------------------- parse ---
  const digests = [];
  let fromCache = 0;
  let parsed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let digest = await readDigest(f.path, f.mtimeMs, f.size);
    if (digest) {
      fromCache++;
    } else {
      digest = await parseTranscript(f.path);
      await writeDigest(f.path, f.mtimeMs, f.size, digest);
      parsed++;
    }
    digests.push(digest);
    onProgress({ phase: 'parsing', done: i + 1, total: files.length, fromCache, parsed });
  }
  onProgress({ phase: 'aggregating', done: files.length, total: files.length, fromCache, parsed });

  // Digests of transcripts Claude Code has since deleted: the only model-level
  // record of those days. Same filters as the live files.
  const archive = (await archivedDigests(index.flatMap((d) => d.files.map((f) => f.path)))).filter(
    (d) => d.cwd && isUnder(d.cwd, root),
  );
  const archivedShown = archive.filter((d) => shown(d.cwd));
  digests.push(...archivedShown);
  const sessionDigests = mergeBySession(digests);

  // ------------------------------------------------- pass 1: session shells ---
  // Cost is computed twice. `rawCost` comes straight from tokens x list price.
  // `cost` rescales that to the session's recorded ledger total, because a
  // transcript can be partial — cleanup trims old files, and a session resumed
  // across files leaves only its tail behind. Rescaling puts the *true* session
  // spend on the days its requests actually happened, which is what every
  // time-series here depends on.
  const unpriced = new Set();
  const shells = [];

  for (const d of sessionDigests) {
    if (!d.messages?.length) continue;
    let rawCost = 0;
    for (const m of d.messages) {
      rawCost += costOf(m);
      if (!isPriced(m.model)) unpriced.add(m.model);
    }
    const ledgerCost = d.sessionId && ledger.has(d.sessionId) ? ledger.get(d.sessionId) : null;
    // Cap the correction: a wildly off ratio means the transcript is a stub,
    // and inflating 3 requests to carry $100 would corrupt every per-request
    // metric downstream. Those sessions keep raw cost and are counted as
    // unattributed instead.
    let factor = 1;
    if (ledgerCost != null && rawCost > 0.005) {
      const ratio = ledgerCost / rawCost;
      if (ratio > 0.2 && ratio < 8) factor = ratio;
    }
    shells.push({ digest: d, rawCost, ledgerCost, factor });
  }

  if (unpriced.size) {
    warnings.push(
      `No published price for ${[...unpriced].join(', ')} — those requests count 0 toward computed cost.`,
    );
  }

  // ------------------------------------------------- pass 2: aggregation ---
  const daily = new Map();
  const dailyModelCost = new Map();
  const dailyProject = new Map(); // `${date} ${project}` -> cost, tokens, engagedMs
  const dailyEdits = new Map(); // `${date} ${model} ${category}` -> lines
  const extTotals = new Map(); // `${date} ${model}` -> cost
  const modelTotals = new Map();
  const branchTotals = new Map();
  const toolTotals = new Map();
  const effortTotals = new Map();
  const sessions = [];

  const totals = {
    cost: 0,
    rawCost: 0,
    requests: 0,
    inputFresh: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    engagedMs: 0,
    toolCalls: 0,
    webSearches: 0,
    sidechainRequests: 0,
    sidechainCost: 0,
    cacheSavings: 0,
    costOutput: 0,
    costCacheWrite: 0,
    costCacheRead: 0,
    costFresh: 0,
  };

  let firstTs = null;
  let lastTs = null;

  for (const { digest: d, rawCost, ledgerCost, factor } of shells) {
    const proj = project(d.cwd || root);
    const session = {
      id: d.sessionId,
      title: d.title,
      branch: d.branches[0] || null,
      start: d.firstTs,
      end: d.lastTs,
      cost: 0,
      rawCost,
      ledgerCost,
      requests: 0,
      inputTotal: 0,
      cacheRead: 0,
      output: 0,
      toolCalls: Object.values(d.toolCounts).reduce((a, b) => a + b, 0),
      engagedMs: d.turnDurations.reduce((a, t) => a + t.ms, 0),
      models: {},
    };

    for (const m of d.messages) {
      const at = new Date(m.ts);
      if (Number.isNaN(at.getTime())) continue;
      const date = dayKey(at);
      const cost = costOf(m) * factor;
      const totalIn = m.inputTokens + m.cacheWrite5m + m.cacheWrite1h + m.cacheRead;

      totals.cost += cost;
      totals.requests++;
      totals.inputFresh += m.inputTokens;
      totals.cacheWrite5m += m.cacheWrite5m;
      totals.cacheWrite1h += m.cacheWrite1h;
      totals.cacheRead += m.cacheRead;
      totals.output += m.outputTokens;
      totals.webSearches += m.webSearches;
      totals.cacheSavings += cacheSavingOf(m) * factor;
      if (m.sidechain) {
        totals.sidechainRequests++;
        totals.sidechainCost += cost;
      }

      const parts = costParts(m);
      bump(daily, date, {
        cost,
        requests: 1,
        inputFresh: m.inputTokens,
        cacheWrite: m.cacheWrite5m + m.cacheWrite1h,
        cacheRead: m.cacheRead,
        output: m.outputTokens,
        inputTotal: totalIn,
        costOutput: parts.output * factor,
        costCacheWrite: parts.cacheWrite * factor,
        costCacheRead: parts.cacheRead * factor,
        costFresh: parts.input * factor,
      });
      totals.costOutput += parts.output * factor;
      totals.costCacheWrite += parts.cacheWrite * factor;
      totals.costCacheRead += parts.cacheRead * factor;
      totals.costFresh += parts.input * factor;
      bump(dailyModelCost, `${date} ${m.model}`, { cost, tokens: totalIn + m.outputTokens });
      bump(dailyProject, `${date} ${proj}`, { cost, tokens: totalIn + m.outputTokens });
      bump(modelTotals, m.model, { cost, requests: 1, output: m.outputTokens, inputTotal: totalIn });
      if (m.branch) bump(branchTotals, m.branch, { cost, requests: 1 });
      bump(effortTotals, m.effort || 'unset', { cost, requests: 1 });

      session.cost += cost;
      session.requests++;
      session.inputTotal += totalIn;
      session.cacheRead += m.cacheRead;
      session.output += m.outputTokens;
      session.models[m.model] = (session.models[m.model] || 0) + 1;

      if (firstTs === null || m.ts < firstTs) firstTs = m.ts;
      if (lastTs === null || m.ts > lastTs) lastTs = m.ts;
    }

    for (const [name, n] of Object.entries(d.toolCounts)) {
      bump(toolTotals, name, { count: n });
      totals.toolCalls += n;
    }

    // Turn-duration records carry their own timestamp, so a session spanning
    // midnight splits across days correctly.
    for (const t of d.turnDurations) {
      const at = new Date(t.ts);
      if (Number.isNaN(at.getTime())) continue;
      totals.engagedMs += t.ms;
      bump(daily, dayKey(at), { engagedMs: t.ms });
      bump(dailyModelCost, `${dayKey(at)} ${t.model || modelAt(d.messages, t.ts)}`, { engagedMs: t.ms });
      bump(dailyProject, `${dayKey(at)} ${proj}`, { engagedMs: t.ms });
    }

    for (const e of d.edits || []) {
      const at = new Date(e.ts);
      if (Number.isNaN(at.getTime())) continue;
      const key = `${dayKey(at)} ${e.model} ${fileCategory(e.ext)} ${proj}`;
      bump(dailyEdits, key, { added: e.added, removed: e.removed, edits: 1 });
      bump(extTotals, e.ext, { added: e.added, removed: e.removed, edits: 1 });
    }

    totals.rawCost += rawCost;
    if (session.requests) sessions.push(session);
  }

  // -------------------------------------------------------- prompt history ---
  const historyDaily = new Map();
  const punch = new Map(); // `${dow}:${hour}` -> prompts
  for (const row of projectHistory) {
    const at = new Date(row.ts);
    bump(historyDaily, dayKey(at), { prompts: 1, chars: row.chars });
    bump(punch, `${at.getDay()}:${at.getHours()}`, { prompts: 1 });
  }
  for (const [date, row] of historyDaily) bump(daily, date, { prompts: row.prompts });

  // ------------------------------------------------------------ timelines ---
  const NUMERIC = [
    'cost', 'requests', 'inputFresh', 'cacheWrite', 'cacheRead', 'output', 'inputTotal', 'engagedMs', 'prompts',
    'costFresh', 'costCacheWrite', 'costCacheRead', 'costOutput',
  ];
  // A date axis must be continuous — an idle week has to occupy a week's width,
  // not collapse to the gap between two adjacent categories. `daily` is filled
  // across the transcript window only; the all-time series is filled below.
  const activityDays = [...daily.keys()].filter((d) => (daily.get(d).requests || 0) > 0).sort();
  const dailyRows = dayRange(activityDays[0], activityDays[activityDays.length - 1]).map((date) => {
    const row = { date, ...(daily.get(date) || {}) };
    for (const k of NUMERIC) row[k] = row[k] || 0;
    row.engagedHours = row.engagedMs / 3_600_000;
    // Rates are undefined on a day with no requests — null, not zero, so the
    // line skips the gap instead of diving to the floor.
    row.avgContext = row.requests ? row.inputTotal / row.requests : null;
    row.cacheHit = row.requests && row.inputTotal ? row.cacheRead / row.inputTotal : null;
    return row;
  });

  const modelNames = [...modelTotals.keys()].sort(
    (a, b) => (modelTotals.get(b).cost || 0) - (modelTotals.get(a).cost || 0),
  );
  // Turn time and edits can name a model with no billed request in range
  // (or 'unknown' for records older than the per-turn model), so the series
  // carry every model seen, cost order first.
  const seriesModels = new Set(modelNames);
  for (const key of [...dailyModelCost.keys(), ...dailyEdits.keys()]) seriesModels.add(key.split(' ')[1]);
  seriesModels.delete('<synthetic>');
  // One row per day, one column per key (model or project), from a
  // `${date}\0${key}` map.
  const seriesOf = (map, keys) => (field, scale = 1) =>
    dailyRows.map((row) => {
      const out = { date: row.date };
      for (const k of keys) out[k] = (map.get(`${row.date} ${k}`)?.[field] || 0) * scale;
      return out;
    });
  const byModel = seriesOf(dailyModelCost, seriesModels);
  const dailyByModelRows = byModel('cost');

  const projectCost = new Map();
  for (const [key, row] of dailyProject) {
    const p = key.split(' ')[1];
    projectCost.set(p, (projectCost.get(p) || 0) + (row.cost || 0));
  }
  const seriesProjects = [...projectCost.keys()].sort((a, b) => projectCost.get(b) - projectCost.get(a));
  const byProject = seriesOf(dailyProject, seriesProjects);

  // ------------------------------------------- all-time cost reconstruction ---
  // Sessions with a surviving transcript are dated exactly. The remaining
  // ledger dollars predate transcript retention; spread them over the undated
  // days in proportion to prompt volume. Estimated, and labelled as such.
  const ledgerTotal = [...ledger.values()].reduce((a, b) => a + b, 0);
  const matchedIds = new Set(sessions.map((s) => s.id).filter((id) => id && ledger.has(id)));
  const datedLedgerCost = [...matchedIds].reduce((a, id) => a + ledger.get(id), 0);
  const undatedCost = Math.max(0, ledgerTotal - datedLedgerCost);

  const coveredDays = new Set(dailyRows.filter((r) => r.requests > 0).map((r) => r.date));
  const uncovered = [...historyDaily.entries()]
    .filter(([date]) => !coveredDays.has(date))
    .map(([date, row]) => ({ date, prompts: row.prompts }));
  const uncoveredPrompts = uncovered.reduce((a, r) => a + r.prompts, 0);

  const estimatedByDay = new Map();
  if (undatedCost > 0 && uncoveredPrompts > 0) {
    for (const row of uncovered) {
      estimatedByDay.set(row.date, (undatedCost * row.prompts) / uncoveredPrompts);
    }
  }

  const seen = [...new Set([...historyDaily.keys(), ...daily.keys()])].sort();
  const allDates = dayRange(seen[0], seen[seen.length - 1]);
  const costTimeline = allDates.map((date) => ({
    date,
    exact: daily.get(date)?.cost || 0,
    estimated: estimatedByDay.get(date) || 0,
    prompts: historyDaily.get(date)?.prompts || 0,
  }));
  let running = 0;
  for (const row of costTimeline) {
    running += row.exact + row.estimated;
    row.cumulative = running;
  }

  // ----------------------------------------------------------- efficiency ---
  const totalInput = totals.inputFresh + totals.cacheWrite5m + totals.cacheWrite1h + totals.cacheRead;
  const sessionCosts = sessions.map((s) => s.cost).sort((a, b) => a - b);
  const topCount = Math.max(1, Math.ceil(sessions.length * 0.05));
  const topShareCost = sessionCosts.slice(-topCount).reduce((a, b) => a + b, 0);
  const engagedHours = totals.engagedMs / 3_600_000;

  const efficiency = {
    cacheHitRate: totalInput ? totals.cacheRead / totalInput : 0,
    cacheWriteShare: totalInput ? (totals.cacheWrite5m + totals.cacheWrite1h) / totalInput : 0,
    freshInputShare: totalInput ? totals.inputFresh / totalInput : 0,
    outputPerRequest: totals.requests ? totals.output / totals.requests : 0,
    avgContextPerRequest: totals.requests ? totalInput / totals.requests : 0,
    costPerMOutputToken: totals.output ? (totals.cost / totals.output) * 1e6 : 0,
    costPerRequest: totals.requests ? totals.cost / totals.requests : 0,
    costPerEngagedHour: engagedHours ? totals.cost / engagedHours : 0,
    costPerPrompt: projectHistory.length ? ledgerTotal / projectHistory.length : 0,
    costPerActiveDay: 0, // filled once activeDays is known
    sidechainCostShare: totals.cost ? totals.sidechainCost / totals.cost : 0,
    medianSessionCost: median(sessionCosts),
    p90SessionCost: quantile(sessionCosts, 0.9),
    top5PctSessionShare: totals.cost ? topShareCost / totals.cost : 0,
    cacheSavingsUsd: totals.cacheSavings,
    outputTokenShare: totalInput + totals.output ? totals.output / (totalInput + totals.output) : 0,
  };

  // Counted across the whole timeline, not just the transcript window — a day
  // you worked is a day you worked, whether or not its transcript survived.
  const activeDays = costTimeline.filter((r) => r.prompts > 0 || r.exact > 0).length;
  efficiency.costPerActiveDay = activeDays ? ledgerTotal / activeDays : 0;

  const reconciliation = {
    matchedSessions: matchedIds.size,
    unmatchedTranscripts: sessions.length - matchedIds.size,
    ledgerCostMatched: datedLedgerCost,
    rawCostMatched: shells
      .filter((s) => s.ledgerCost != null)
      .reduce((a, s) => a + s.rawCost, 0),
    rescaledSessions: shells.filter((s) => s.factor !== 1).length,
  };
  reconciliation.rawVsLedgerPct = reconciliation.ledgerCostMatched
    ? (reconciliation.rawCostMatched - reconciliation.ledgerCostMatched) / reconciliation.ledgerCostMatched
    : 0;

  function projectList() {
    const rows = new Map();
    const row = (p) => {
      if (!rows.has(p)) rows.set(p, { path: p, cost: 0, sessions: 0, prompts: 0, transcripts: 0, lastSeen: 0 });
      return rows.get(p);
    };
    for (const [file, t] of ledgerByFile) Object.assign(row(path.dirname(file)), { cost: t.cost, sessions: t.sessions });
    for (const d of allDirs) row(project(d.cwd)).transcripts += d.files.length;
    for (const d of archive) row(project(d.cwd)).transcripts++;
    for (const h of rootHistory) {
      const r = row(project(h.project));
      r.prompts++;
      if (h.ts > r.lastSeen) r.lastSeen = h.ts;
    }
    return [...rows.values()]
      .map((r) => ({ ...r, hidden: hidden.has(r.path) }))
      .sort((a, b) => b.cost - a.cost || b.prompts - a.prompts);
  }

  const report = {
    root,
    home: os.homedir(),
    generatedAt: new Date().toISOString(),
    scanMs: Date.now() - startedAt,
    warnings,
    sources: {
      transcriptDirs: dirs.length,
      transcriptFiles: files.length,
      filesParsed: parsed,
      filesFromCache: fromCache,
      ledgerFiles,
      historyRows: projectHistory.length,
    },
    coverage: {
      transcriptFirst: firstTs,
      transcriptLast: lastTs,
      historyFirst: projectHistory.length ? new Date(projectHistory[0].ts).toISOString() : null,
      historyLast: projectHistory.length
        ? new Date(projectHistory[projectHistory.length - 1].ts).toISOString()
        : null,
      sessionsInLedger: ledger.size,
      sessionsWithTranscripts: sessions.length,
      sessionsMatched: matchedIds.size,
      costDatedUsd: datedLedgerCost,
      costUndatedUsd: undatedCost,
      costCoverage: ledgerTotal ? datedLedgerCost / ledgerTotal : 0,
    },
    totals: {
      ...totals,
      totalInput,
      ledgerCost: ledgerTotal,
      sessions: sessions.length,
      activeDays,
      promptsAllTime: projectHistory.length,
    },
    daily: dailyRows,
    dailyByModel: {
      models: [...seriesModels],
      rows: dailyByModelRows,
      tokens: byModel('tokens'),
      engagedHours: byModel('engagedMs', 1 / 3_600_000),
    },
    // Same shape, keyed by project path (costliest first).
    dailyByProject: {
      projects: seriesProjects,
      rows: byProject('cost'),
      tokens: byProject('tokens'),
      engagedHours: byProject('engagedMs', 1 / 3_600_000),
    },
    edits: {
      categories: FILE_CATEGORIES.map(({ key, label }) => ({ key, label })),
      rows: [...dailyEdits.entries()].map(([key, row]) => {
        const [date, model, category, project] = key.split(' ');
        return { date, model, category, project, ...row };
      }),
      extensions: [...extTotals.entries()]
        .map(([ext, row]) => ({ ext, category: fileCategory(ext), ...row }))
        .sort((a, b) => b.added + b.removed - (a.added + a.removed)),
    },
    projects: projectList(),
    archive: { sessions: archivedShown.length, sessionsTotal: archive.length },
    costTimeline,
    punchcard: [...punch.entries()].map(([key, row]) => {
      const [dow, hour] = key.split(':').map(Number);
      return { dow, hour, prompts: row.prompts };
    }),
    models: modelNames.map((model) => {
      const row = modelTotals.get(model);
      return {
        model,
        cost: row.cost,
        requests: row.requests,
        output: row.output,
        inputTotal: row.inputTotal,
        share: totals.cost ? row.cost / totals.cost : 0,
      };
    }),
    branches: [...branchTotals.entries()]
      .map(([branch, row]) => ({ branch, ...row }))
      .sort((a, b) => b.cost - a.cost),
    tools: [...toolTotals.entries()]
      .map(([name, row]) => ({ name, count: row.count }))
      .sort((a, b) => b.count - a.count),
    effort: [...effortTotals.entries()]
      .map(([effort, row]) => ({ effort, ...row }))
      .sort((a, b) => b.cost - a.cost),
    sessions: sessions
      .map((s) => ({
        ...s,
        cacheHit: s.inputTotal ? s.cacheRead / s.inputTotal : 0,
        topModel: Object.entries(s.models).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
        durationMs: s.start && s.end ? new Date(s.end) - new Date(s.start) : 0,
      }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 400),
    sessionCostHistogram: histogram(sessionCosts),
    efficiency,
    reconciliation,
  };

  report.insights = buildInsights(report);
  return report;
}

/**
 * What the cache-read tokens on this request would have cost at full input
 * price. Not hypothetical — those tokens were sent and served from cache.
 */
function cacheSavingOf(m) {
  if (!m.cacheRead) return 0;
  const base = { model: m.model, speed: m.speed, inputTokens: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, outputTokens: 0 };
  const atFullPrice = costOf({ ...base, inputTokens: m.cacheRead });
  const asCached = costOf({ ...base, cacheRead: m.cacheRead });
  return atFullPrice - asCached;
}

/** Log-spaced buckets — session cost spans several orders of magnitude. */
function histogram(sortedCosts) {
  const edges = [0, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, Infinity];
  const buckets = [];
  for (let i = 0; i < edges.length - 1; i++) {
    buckets.push({ from: edges[i], to: edges[i + 1], count: 0, cost: 0 });
  }
  for (const cost of sortedCosts) {
    for (let i = 0; i < buckets.length; i++) {
      if (cost >= edges[i] && cost < edges[i + 1]) {
        buckets[i].count++;
        buckets[i].cost += cost;
        break;
      }
    }
  }
  return buckets;
}

function buildInsights(r) {
  const out = [];
  const usd = (n) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString()}`;
  const pct = (n) => `${(n * 100).toFixed(0)}%`;

  if (r.totals.ledgerCost > 0) {
    out.push({
      level: 'info',
      title: `${usd(r.totals.ledgerCost)} across ${r.coverage.sessionsInLedger.toLocaleString()} sessions`,
      detail:
        r.coverage.costCoverage < 0.95
          ? `${pct(r.coverage.costCoverage)} of that has a surviving transcript and is dated exactly. The rest predates the ~30-day retention window and is spread across the timeline in proportion to prompt volume.`
          : 'Every session in the ledger still has a transcript, so the whole timeline is exact.',
    });
  }

  const hit = r.efficiency.cacheHitRate;
  if (r.totals.totalInput > 1e6) {
    out.push({
      level: hit >= 0.9 ? 'good' : hit >= 0.75 ? 'warn' : 'bad',
      title: `Cache hit rate ${pct(hit)}`,
      detail:
        hit >= 0.9
          ? `Prompt caching returned ${usd(r.efficiency.cacheSavingsUsd)} against full input pricing over the analyzed window.`
          : `Only ${pct(hit)} of input tokens were served from cache, and writes are ${pct(r.efficiency.cacheWriteShare)} of input. A low hit rate usually means short-lived sessions, tools changing mid-run, or something volatile early in the prompt.`,
    });
  }

  if (r.efficiency.top5PctSessionShare > 0.25 && r.totals.sessions > 20) {
    out.push({
      level: 'warn',
      title: `Top 5% of sessions are ${pct(r.efficiency.top5PctSessionShare)} of spend`,
      detail: `Median session costs ${usd(r.efficiency.medianSessionCost)}, the 90th percentile ${usd(r.efficiency.p90SessionCost)}. A handful of long sessions dominate the bill — those are where a /clear or a tighter scope pays off most.`,
    });
  }

  if (r.efficiency.avgContextPerRequest > 0) {
    const k = Math.round(r.efficiency.avgContextPerRequest / 1000);
    out.push({
      level: r.efficiency.avgContextPerRequest > 400_000 ? 'warn' : 'info',
      title: `${k}k tokens of context per request on average`,
      detail: `Each request re-sends the whole conversation. At ${usd(r.efficiency.costPerRequest)} per request and ${Math.round(r.efficiency.outputPerRequest)} output tokens, you pay ${usd(r.efficiency.costPerMOutputToken)} per million tokens actually written.`,
    });
  }

  if (r.efficiency.sidechainCostShare > 0.1) {
    out.push({
      level: 'info',
      title: `Subagents are ${pct(r.efficiency.sidechainCostShare)} of cost`,
      detail: `${r.totals.sidechainRequests.toLocaleString()} of ${r.totals.requests.toLocaleString()} requests ran in a sidechain.`,
    });
  }

  const busiest = [...r.daily].sort((a, b) => b.cost - a.cost)[0];
  if (busiest?.cost > 0) {
    out.push({
      level: 'info',
      title: `Peak day ${busiest.date}: ${usd(busiest.cost)}`,
      detail: `${busiest.requests.toLocaleString()} requests and ${busiest.engagedHours.toFixed(1)}h of engaged model time in one day.`,
    });
  }

  const weekend = r.punchcard.filter((p) => p.dow === 0 || p.dow === 6).reduce((a, p) => a + p.prompts, 0);
  const allPrompts = r.punchcard.reduce((a, p) => a + p.prompts, 0);
  if (allPrompts > 100) {
    const span =
      r.coverage.historyFirst && r.coverage.historyLast
        ? ` between ${r.coverage.historyFirst.slice(0, 10)} and ${r.coverage.historyLast.slice(0, 10)}`
        : '';
    out.push({
      level: 'info',
      title: `${r.totals.activeDays} active days${span}`,
      detail: `${allPrompts.toLocaleString()} prompts, ${pct(weekend / allPrompts)} of them on a weekend, at ${usd(r.efficiency.costPerActiveDay)} per active day.`,
    });
  }

  const trend = contextTrend(r.daily);
  if (trend) {
    out.push({
      level: trend.delta > 0.25 ? 'warn' : 'info',
      title: `Context per request ${trend.delta >= 0 ? 'up' : 'down'} ${pct(Math.abs(trend.delta))} lately`,
      detail: `${Math.round(trend.older / 1000)}k → ${Math.round(trend.recent / 1000)}k tokens per request over the last 7 active days. Rising context means sessions run longer before a reset, which raises cost per unit of output.`,
    });
  }

  if (r.reconciliation.rescaledSessions > 0) {
    out.push({
      level: 'info',
      title: `${r.reconciliation.rescaledSessions} session(s) reconciled against the cost ledger`,
      detail: `Raw token pricing came to ${pct(Math.abs(r.reconciliation.rawVsLedgerPct))} ${r.reconciliation.rawVsLedgerPct < 0 ? 'below' : 'above'} the recorded totals, usually because a transcript is partial. Dollar figures follow the ledger; token figures are raw.`,
    });
  }

  return out;
}

/** Compare mean context of the last 7 active days against the 7 before them. */
function contextTrend(daily) {
  const active = daily.filter((d) => d.requests > 0);
  if (active.length < 8) return null;
  const recent = active.slice(-7);
  const older = active.slice(-14, -7);
  if (!older.length) return null;
  const mean = (rows) =>
    rows.reduce((a, r) => a + r.inputTotal, 0) / Math.max(1, rows.reduce((a, r) => a + r.requests, 0));
  const r = mean(recent);
  const o = mean(older);
  if (!o) return null;
  return { recent: r, older: o, delta: (r - o) / o };
}

// ----------------------------------------------------------- file types ---
// Edited files grouped by what they are, for the line-count filter. Docs and
// ideas live in Markdown; "config & data" is structured text that isn't code.
const FILE_CATEGORIES = [
  {
    key: 'code',
    label: 'Code',
    exts: `.js .mjs .cjs .ts .tsx .jsx .py .pyi .rs .go .java .kt .kts .swift .c .h .cc .cpp .cxx .hpp .m .mm
      .cs .rb .php .lua .sh .bash .zsh .fish .ps1 .sql .html .htm .css .scss .sass .less .vue .svelte .astro
      .glsl .wgsl .frag .vert .comp .metal .hlsl .r .jl .scala .dart .zig .ex .exs .hs .ml .clj .elm .nim .gd
      .ipynb .tf .proto .graphql .cu Makefile Dockerfile Justfile`,
  },
  { key: 'markdown', label: 'Markdown', exts: '.md .mdx .markdown' },
  {
    key: 'config',
    label: 'Config & data',
    exts: `.json .jsonc .jsonl .yaml .yml .toml .ini .cfg .conf .xml .plist .csv .tsv .lock .properties .env
      .gitignore .dockerignore .editorconfig .npmrc .nvmrc`,
  },
  { key: 'other', label: 'Other', exts: '' },
];
const CATEGORY_OF = new Map(FILE_CATEGORIES.flatMap((c) => c.exts.split(/\s+/).filter(Boolean).map((e) => [e, c.key])));

function fileCategory(ext) {
  return CATEGORY_OF.get(ext) || (ext.startsWith('.env') ? 'config' : 'other');
}
