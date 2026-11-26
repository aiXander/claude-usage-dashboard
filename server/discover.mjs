import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

export const CLAUDE_HOME = path.join(os.homedir(), '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
export const HISTORY_FILE = path.join(CLAUDE_HOME, 'history.jsonl');

const LEDGER_NAME = '.claude-costs';

/**
 * Claude names each transcript directory after the cwd with `/` and `_`
 * both flattened to `-`, which is lossy and can't be reversed. The `cwd`
 * field inside the transcript is authoritative, so read one record from the
 * first file instead of decoding the name.
 */
async function cwdOfProjectDir(dir) {
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  for (const name of files) {
    if (!name.endsWith('.jsonl')) continue;
    const cwd = await firstCwdInFile(path.join(dir, name));
    if (cwd) return cwd;
  }
  return null;
}

function firstCwdInFile(filePath) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      rl.close();
      stream.destroy();
      resolve(value);
    };
    rl.on('line', (line) => {
      const at = line.indexOf('"cwd"');
      if (at === -1) return;
      try {
        const rec = JSON.parse(line);
        if (rec.cwd) finish(rec.cwd);
      } catch {
        /* partial line — keep looking */
      }
    });
    rl.on('close', () => finish(null));
    stream.on('error', () => finish(null));
  });
}

let projectIndexCache = null;

/** [{ dir, cwd, files: [{path, mtimeMs, size}] }] for every transcript directory. */
export async function projectIndex({ force = false } = {}) {
  if (projectIndexCache && !force) return projectIndexCache;

  let dirs = [];
  try {
    dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return (projectIndexCache = []);
  }

  const out = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, entry.name);
    const cwd = await cwdOfProjectDir(dir);
    if (!cwd) continue;

    // `<session>.jsonl` holds the main thread; subagents write their own
    // transcripts to `<session>/subagents/agent-*.jsonl`, under the parent's
    // sessionId. Skipping them drops every subagent request.
    const paths = [];
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        paths.push(path.join(dir, entry.name));
      } else if (entry.isDirectory()) {
        const sub = path.join(dir, entry.name, 'subagents');
        const names = await fsp.readdir(sub).catch(() => []);
        for (const name of names) if (name.endsWith('.jsonl')) paths.push(path.join(sub, name));
      }
    }
    const files = [];
    for (const full of paths) {
      try {
        const st = await fsp.stat(full);
        files.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* raced with cleanup */
      }
    }
    out.push({ dir, cwd, files });
  }
  return (projectIndexCache = out);
}

export function isUnder(child, parent) {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * The statusline hook writes its per-session cost ledger to the git root when
 * there is one, and to the cwd otherwise — so a repo has one ledger at the top
 * while a loose folder tree may have several. Collect all of them under `root`.
 *
 * The tree walk is depth-capped (a home-folder walk would otherwise crawl
 * everything), so it misses deep repos like ~/Documents/GitHub/a/b/repo. The
 * ledger above every cwd a session actually ran in (`cwds`) is added on top,
 * which finds those at any depth.
 */
export async function findLedgers(root, maxDepth = 4, cwds = []) {
  const found = [];
  const skip = new Set(['node_modules', '.git', 'venv', '.venv', 'dist', 'build', '__pycache__', '.next']);

  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === LEDGER_NAME) {
        found.push(path.join(dir, entry.name));
      } else if (entry.isDirectory() && depth < maxDepth && !skip.has(entry.name) && !entry.isSymbolicLink()) {
        await walk(path.join(dir, entry.name), depth + 1);
      }
    }
  }

  await walk(root, 0);
  const seen = new Set(found);
  for (const cwd of new Set(cwds)) {
    const dir = nearestLedgerRoot(cwd);
    const file = dir && path.join(dir, LEDGER_NAME);
    if (file && isUnder(dir, root) && !seen.has(file)) {
      seen.add(file);
      found.push(file);
    }
  }
  return found;
}

/**
 * Merge every ledger under `root` into one sessionId -> cost map. `byFile`
 * keeps each ledger's own total (the project list needs it); `keep(file)`
 * drops a hidden project's ledger from the merge.
 */
export async function readLedgers(root, keep = () => true, cwds = []) {
  const all = await findLedgers(root, 4, cwds);
  const costs = new Map();
  const byFile = new Map();
  const unreadable = [];
  const files = [];
  for (const file of all) {
    try {
      const data = JSON.parse(await fsp.readFile(file, 'utf8'));
      const values = Object.values(data).filter((v) => typeof v === 'number' && Number.isFinite(v));
      byFile.set(file, { cost: values.reduce((a, b) => a + b, 0), sessions: values.length });
      if (!keep(file)) continue;
      files.push(file);
      for (const [sessionId, cost] of Object.entries(data)) {
        if (typeof cost === 'number' && Number.isFinite(cost)) {
          // A session id is unique, so a later ledger repeating one is the
          // same session, not extra spend — keep the larger (later) value.
          costs.set(sessionId, Math.max(costs.get(sessionId) ?? 0, cost));
        }
      }
    } catch {
      unreadable.push(file);
    }
  }
  return { costs, files, byFile, unreadable };
}

let historyCache = null;

/** Every user prompt ever typed: { ts, project, chars }. ~11 months of history. */
export async function readHistory({ force = false } = {}) {
  if (historyCache && !force) return historyCache;
  const rows = [];
  try {
    const stream = fs.createReadStream(HISTORY_FILE, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (!rec.timestamp || !rec.project) continue;
        rows.push({
          ts: rec.timestamp,
          project: rec.project,
          chars: (rec.display || '').length,
        });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no history file */
  }
  rows.sort((a, b) => a.ts - b.ts);
  return (historyCache = rows);
}

/**
 * Known project roots, for the dashboard's quick-pick list. A root is the
 * nearest ancestor of a known cwd that owns a `.claude-costs` ledger; cwds
 * with no ledger anywhere above them fall back to the cwd itself.
 */
export async function knownRoots() {
  const index = await projectIndex();
  const history = await readHistory();
  const cwds = new Set(index.map((p) => p.cwd));
  for (const row of history) cwds.add(row.project);

  const roots = new Map();
  for (const cwd of cwds) {
    if (!fs.existsSync(cwd)) continue;
    const root = nearestLedgerRoot(cwd) || cwd;
    if (!roots.has(root)) roots.set(root, { path: root, cost: 0, sessions: 0, prompts: 0, lastSeen: 0 });
  }

  for (const [root, entry] of roots) {
    try {
      const ledger = JSON.parse(fs.readFileSync(path.join(root, LEDGER_NAME), 'utf8'));
      const values = Object.values(ledger).filter((v) => typeof v === 'number');
      entry.cost = values.reduce((a, b) => a + b, 0);
      entry.sessions = values.length;
    } catch {
      /* no ledger at the root — cost stays 0 */
    }
    for (const row of history) {
      if (isUnder(row.project, root)) {
        entry.prompts++;
        if (row.ts > entry.lastSeen) entry.lastSeen = row.ts;
      }
    }
  }

  return [...roots.values()].sort((a, b) => b.cost - a.cost || b.prompts - a.prompts);
}

/**
 * The project a cwd belongs to, as the dashboard groups them: its nearest
 * ancestor holding a `.claude-costs` ledger (the statusline writes one per git
 * root), clamped to `root`. A cwd with no ledger above it is its own project.
 */
export function projectOf(cwd, root, memo) {
  if (memo?.has(cwd)) return memo.get(cwd);
  const ledgerRoot = nearestLedgerRoot(cwd);
  const project = ledgerRoot && isUnder(ledgerRoot, root) ? ledgerRoot : isUnder(cwd, root) && !ledgerRoot ? cwd : root;
  memo?.set(cwd, project);
  return project;
}

function nearestLedgerRoot(startDir) {
  let dir = startDir;
  const home = os.homedir();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, LEDGER_NAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return null;
    dir = parent;
  }
  return null;
}
