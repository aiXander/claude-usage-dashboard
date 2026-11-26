import fs from 'node:fs';
import readline from 'node:readline';

// Transcript lines are large (tens of KB) and most of the bytes are records we
// don't need — file-history snapshots, attachments, tool results. A substring
// test before JSON.parse skips those without materialising an object graph,
// which is the difference between ~10s and ~90s on a 400MB project.
// `structuredPatch` lines are Edit/Write results: the exact diff of a
// successful file change, which the assistant's tool_use input can't give
// (a failed or rejected edit has the same input, and a Write doesn't say what
// it overwrote).
const WANTED = ['"type":"assistant"', '"turn_duration"', '"ai-title"', '"structuredPatch"'];

function wanted(line) {
  for (const marker of WANTED) if (line.includes(marker)) return true;
  return false;
}

/**
 * Read one .jsonl transcript into a compact digest.
 *
 * Assistant rows are deduped on `message.id`: the same message is written
 * several times during streaming/replay, so summing raw rows double-counts
 * tokens. (Same invariant the statusline script relies on.)
 */
export async function parseTranscript(filePath) {
  const byMessageId = new Map();
  const toolCounts = {};
  const turnDurations = [];
  const edits = [];
  const toolModel = new Map(); // tool_use id -> model that issued it
  const countedEdits = new Set(); // tool_use ids already counted (rows replay)
  let lastModel = null;
  const branches = new Set();
  const versions = new Set();
  let title = null;
  let cwd = null;
  let sessionId = null;
  let malformed = 0;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.length < 2 || !wanted(line)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }

    if (rec.type === 'ai-title') {
      if (rec.aiTitle) title = rec.aiTitle;
      continue;
    }

    if (rec.type === 'system' && rec.subtype === 'turn_duration') {
      if (typeof rec.durationMs === 'number') {
        // A turn's time goes to the model that answered it (its last reply).
        turnDurations.push({ ts: rec.timestamp, ms: rec.durationMs, model: lastModel });
      }
      continue;
    }

    if (rec.type === 'user') {
      const edit = editOf(rec, toolModel, countedEdits);
      if (edit) edits.push(edit);
      continue;
    }

    if (rec.type !== 'assistant' || !rec.message) continue;

    if (!cwd && rec.cwd) cwd = rec.cwd;
    if (!sessionId && (rec.sessionId || rec.session_id)) {
      sessionId = rec.sessionId || rec.session_id;
    }
    if (rec.gitBranch) branches.add(rec.gitBranch);
    if (rec.message.model && rec.message.model !== '<synthetic>') lastModel = rec.message.model;
    for (const block of rec.message.content || []) {
      if (block?.type === 'tool_use' && block.id) toolModel.set(block.id, rec.message.model || 'unknown');
    }
    if (rec.version) versions.add(rec.version);

    // Tool calls are counted per record, not per deduped message: a replayed
    // record repeats the same tool_use blocks, so gate on the dedupe below.
    const id = rec.message.id;
    const usage = rec.message.usage;
    if (!id || !usage || byMessageId.has(id)) continue;

    // `cache_creation` splits writes by TTL (they bill 1.25x vs 2x). Older
    // records only have the flat total — attribute those to the 5m default.
    const cc = usage.cache_creation;
    const write5m = cc ? cc.ephemeral_5m_input_tokens || 0 : usage.cache_creation_input_tokens || 0;
    const write1h = cc ? cc.ephemeral_1h_input_tokens || 0 : 0;

    byMessageId.set(id, {
      ts: rec.timestamp,
      model: rec.message.model || 'unknown',
      speed: usage.speed || 'standard',
      effort: rec.effort || null,
      sidechain: rec.isSidechain === true,
      branch: rec.gitBranch || null,
      inputTokens: usage.input_tokens || 0,
      cacheWrite5m: write5m,
      cacheWrite1h: write1h,
      cacheRead: usage.cache_read_input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      webSearches: usage.server_tool_use?.web_search_requests || 0,
    });

    for (const block of rec.message.content || []) {
      if (block?.type === 'tool_use' && block.name) {
        toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
      }
    }
  }

  const messages = [...byMessageId.values()].filter((m) => m.ts);
  messages.sort((a, b) => (a.ts < b.ts ? -1 : 1));

  return {
    sessionId,
    cwd,
    title,
    branches: [...branches],
    versions: [...versions],
    messages,
    toolCounts,
    turnDurations,
    edits,
    malformed,
    firstTs: messages.length ? messages[0].ts : null,
    lastTs: messages.length ? messages[messages.length - 1].ts : null,
  };
}

/**
 * One successful Edit/Write as { ts, model, ext, added, removed }, from the
 * tool result's `structuredPatch` (hunks of ' ', '+', '-' prefixed lines).
 * A created file has an empty patch and counts its content as added. Edits
 * made through Bash (sed, heredocs) leave no patch and are not counted.
 */
function editOf(rec, toolModel, counted) {
  const result = rec.toolUseResult;
  if (!result || !Array.isArray(result.structuredPatch) || !result.filePath) return null;
  const id = (rec.message?.content || []).find((b) => b?.type === 'tool_result')?.tool_use_id;
  if (id) {
    if (counted.has(id)) return null;
    counted.add(id);
  }
  let added = 0;
  let removed = 0;
  for (const hunk of result.structuredPatch) {
    for (const line of hunk.lines || []) {
      if (line[0] === '+') added++;
      else if (line[0] === '-') removed++;
    }
  }
  // A Write that creates a file records an empty patch; its content is the add.
  if (result.type === 'create' && !added && typeof result.content === 'string') {
    added = result.content.split('\n').length - (result.content.endsWith('\n') ? 1 : 0);
  }
  if (!added && !removed) return null;
  return {
    ts: rec.timestamp,
    model: (id && toolModel.get(id)) || 'unknown',
    ext: extOf(result.filePath),
    added,
    removed,
  };
}

/** `.ts`, `.md` … lowercased; extensionless files keep their name (`Makefile`). */
function extOf(filePath) {
  const name = filePath.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : name;
}
