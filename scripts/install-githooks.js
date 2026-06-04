#!/usr/bin/env node
/**
 * scripts/install-githooks.js
 *
 * Runs on `npm install` via the `prepare` script. Points git at the
 * project's `.githooks/` directory so this repo's git hooks (pre-commit,
 * pre-push) fire for every commit/push — including from worktrees, since
 * the config is stored in the main repo's .git/config.
 *
 * No-op when:
 *   - `CI=true` (CI doesn't need local hooks)
 *   - `.git` is missing (e.g. fresh tarball or npm-installed dependency)
 *   - already set to the same path (idempotent)
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const TARGET = '.githooks';

if (process.env.CI) {
  process.exit(0);
}
if (!fs.existsSync('.git')) {
  process.exit(0);
}

try {
  const current = execSync('git config --get core.hooksPath', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (current === TARGET) {
    process.exit(0);
  }
} catch {
  // No config set yet — fall through and set it.
}

try {
  execSync(`git config core.hooksPath ${TARGET}`, { stdio: 'inherit' });
  console.log(`[install-githooks] core.hooksPath → ${TARGET}`);
} catch (err) {
  console.warn('[install-githooks] failed to set core.hooksPath:', err && err.message ? err.message : err);
}
