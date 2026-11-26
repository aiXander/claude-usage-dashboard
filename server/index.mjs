import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { analyze } from './aggregate.mjs';
import { projectIndex, knownRoots, isUnder, CLAUDE_HOME } from './discover.mjs';
import { cacheStats, clearCache } from './cache.mjs';

const PORT = Number(process.env.PORT || 5178);
const app = express();
app.use(express.json());

// Local-only tool: it reads the user's own filesystem, so it must never be
// reachable from anywhere but this machine (see the listen() call below).

// ------------------------------------------------------------ file browser ---

app.get('/api/fs', async (req, res) => {
  const target = path.resolve(String(req.query.path || os.homedir()));
  try {
    const st = await fsp.stat(target);
    if (!st.isDirectory()) return res.status(400).json({ error: 'Not a directory' });
  } catch {
    return res.status(404).json({ error: `Cannot read ${target}` });
  }

  const index = await projectIndex();
  const cwds = index.map((p) => p.cwd);

  let entries = [];
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch (err) {
    return res.status(403).json({ error: String(err.message || err) });
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const full = path.join(target, entry.name);
    dirs.push({
      name: entry.name,
      path: full,
      // Does any recorded Claude session live at or below here?
      hasClaudeData: cwds.some((cwd) => isUnder(cwd, full)),
      hasLedger: await exists(path.join(full, '.claude-costs')),
    });
  }
  dirs.sort((a, b) => Number(b.hasClaudeData) - Number(a.hasClaudeData) || a.name.localeCompare(b.name));

  const parent = path.dirname(target);
  res.json({
    path: target,
    parent: parent === target ? null : parent,
    home: os.homedir(),
    hasClaudeData: cwds.some((cwd) => isUnder(cwd, target)),
    hasLedger: await exists(path.join(target, '.claude-costs')),
    dirs,
  });
});

app.get('/api/roots', async (_req, res) => {
  try {
    res.json({ roots: await knownRoots(), claudeHome: CLAUDE_HOME });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ------------------------------------------------------------------- jobs ---
// A cold scan of a large project reads hundreds of MB, so analysis runs as a
// polled background job rather than one long request.

const jobs = new Map();

app.post('/api/analyze', async (req, res) => {
  const root = path.resolve(String(req.body?.root || ''));
  if (!root || !(await exists(root))) {
    return res.status(400).json({ error: 'root does not exist' });
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    root,
    status: 'running',
    startedAt: Date.now(),
    progress: { phase: 'starting', done: 0, total: 0 },
    result: null,
    error: null,
  };
  jobs.set(id, job);

  const exclude = Array.isArray(req.body?.exclude) ? req.body.exclude.map(String) : [];
  analyze(
    root,
    (progress) => {
      job.progress = progress;
    },
    { exclude },
  )
    .then((result) => {
      job.result = result;
      job.status = 'done';
    })
    .catch((err) => {
      job.error = String(err?.stack || err);
      job.status = 'error';
    });

  // Keep the last few jobs only.
  for (const [key, value] of jobs) {
    if (jobs.size <= 8) break;
    if (value.status !== 'running') jobs.delete(key);
  }

  res.json({ id });
});

app.get('/api/analyze/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  if (job.status === 'done') return res.json({ status: 'done', result: job.result });
  if (job.status === 'error') return res.status(500).json({ status: 'error', error: job.error });
  res.json({ status: 'running', progress: job.progress, elapsedMs: Date.now() - job.startedAt });
});

// ------------------------------------------------------------------ cache ---

app.get('/api/cache', async (_req, res) => res.json(await cacheStats()));
app.delete('/api/cache', async (_req, res) => {
  const index = await projectIndex({ force: true });
  await clearCache(index.flatMap((d) => d.files.map((f) => f.path)));
  res.json({ ok: true });
});

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// Serve the built frontend when it exists (`npm run build` then `npm start`).
const dist = path.join(import.meta.dirname, '..', 'dist');
if (await exists(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`claude-usage-dashboard API on http://127.0.0.1:${PORT}`);
});
