// Digest every transcript into the cache, which doubles as the archive (see
// cache.mjs). Claude Code deletes transcripts after ~30 days, and only a
// digest written before that keeps a session's per-model, per-day detail, so
// this is meant to run on a schedule even when nobody opens the dashboard.
//
//   node server/archive.mjs      (or: make archive)

import { projectIndex } from './discover.mjs';
import { parseTranscript } from './parse.mjs';
import { readDigest, writeDigest, cacheStats } from './cache.mjs';

const files = (await projectIndex({ force: true })).flatMap((d) => d.files);
let parsed = 0;
for (const f of files) {
  if (await readDigest(f.path, f.mtimeMs, f.size)) continue;
  await writeDigest(f.path, f.mtimeMs, f.size, await parseTranscript(f.path));
  parsed++;
}
const stats = await cacheStats();
console.log(
  `${new Date().toISOString()} archived ${parsed} new/changed of ${files.length} transcripts; ` +
    `${stats.entries} digests, ${(stats.bytes / 1e6).toFixed(1)} MB`,
);
