// Copy non-TS assets that `tsc` does not emit into dist/, preserving paths.
// Currently: JSON data files read at runtime (e.g. config/reserved-slugs.json).
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const SRC = 'src';
const OUT = 'dist';

/** Recursively find files matching a predicate under a dir. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const assets = walk(SRC).filter((f) => f.endsWith('.json'));
for (const file of assets) {
  const dest = join(OUT, relative(SRC, file));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file, dest);
  console.log(`[copy-assets] ${file} → ${dest}`);
}
