import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Transcripts are append-only and never rewritten, so (mtime, size) is a sound
// cache key: a re-parse is needed only when the file grew.
//
// The cache doubles as the archive. Claude Code deletes transcripts after ~30
// days; a digest whose transcript is gone is the only per-model, per-day record
// left of that session, so it is kept forever and still counted (see
// `archivedDigests`). It is ~1% of the transcript's size.
const CACHE_DIR = path.join(os.homedir(), '.cache', 'claude-usage-dashboard', 'digests');
const VERSION = 8; // bump to invalidate every digest after a parser change

let ready = null;
function ensureDir() {
  if (!ready) ready = fsp.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
  return ready;
}

function keyFor(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex') + '.json';
}

export async function readDigest(filePath, mtimeMs, size) {
  await ensureDir();
  try {
    const raw = await fsp.readFile(path.join(CACHE_DIR, keyFor(filePath)), 'utf8');
    const entry = JSON.parse(raw);
    if (entry.v === VERSION && entry.mtimeMs === mtimeMs && entry.size === size) {
      return entry.digest;
    }
  } catch {
    /* miss */
  }
  return null;
}

export async function writeDigest(filePath, mtimeMs, size, digest) {
  await ensureDir();
  const target = path.join(CACHE_DIR, keyFor(filePath));
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify({ v: VERSION, path: filePath, mtimeMs, size, digest }));
    await fsp.rename(tmp, target);
  } catch {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// Oldest digest shape the aggregator can still read: v6 lacks `edits` and
// per-turn models, which only leaves those days without line counts.
const OLDEST_ARCHIVE_VERSION = 4;

/**
 * Digests of transcripts that no longer exist on disk. `livePaths` is every
 * transcript path currently present; anything else in the cache is archive.
 */
export async function archivedDigests(livePaths) {
  await ensureDir();
  const live = new Set([...livePaths].map(keyFor));
  const out = [];
  for (const name of await fsp.readdir(CACHE_DIR).catch(() => [])) {
    if (!name.endsWith('.json') || live.has(name)) continue;
    try {
      const entry = JSON.parse(await fsp.readFile(path.join(CACHE_DIR, name), 'utf8'));
      if (entry.v >= OLDEST_ARCHIVE_VERSION && entry.digest?.messages?.length) out.push(entry.digest);
    } catch {
      /* partial write — skip */
    }
  }
  return out;
}

export async function cacheStats() {
  await ensureDir();
  try {
    const files = await fsp.readdir(CACHE_DIR);
    let bytes = 0;
    for (const f of files) {
      const st = await fsp.stat(path.join(CACHE_DIR, f)).catch(() => null);
      if (st) bytes += st.size;
    }
    return { dir: CACHE_DIR, entries: files.length, bytes };
  } catch {
    return { dir: CACHE_DIR, entries: 0, bytes: 0 };
  }
}

/**
 * Drop the digests that can be rebuilt (their transcript still exists). The
 * archive — digests of deleted transcripts — is irreplaceable and stays.
 */
export async function clearCache(livePaths) {
  await ensureDir();
  for (const p of livePaths) await fsp.rm(path.join(CACHE_DIR, keyFor(p)), { force: true });
}
