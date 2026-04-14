#!/usr/bin/env npx tsx
// Backfill historical generation_log costs to production's cost_entries.
//
// Manually triggered — run on each staging/local server after deploying
// the cost-reporting feature. Safe to run multiple times (idempotent via
// source_ref dedup on production).
//
// Usage:
//   COST_REPORT_URL=https://api.carkedit.com/api/carkedit/costs/report \
//   COST_REPORT_KEY=<secret> \
//   DEPLOY_ENV=staging \
//   npx tsx scripts/backfill-costs.ts

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../data/games.db");

const COST_REPORT_URL = process.env.COST_REPORT_URL;
const COST_REPORT_KEY = process.env.COST_REPORT_KEY;
const DEPLOY_ENV = process.env.DEPLOY_ENV;

if (!COST_REPORT_URL || !COST_REPORT_KEY || !DEPLOY_ENV) {
  console.error("Required env vars: COST_REPORT_URL, COST_REPORT_KEY, DEPLOY_ENV");
  process.exit(1);
}

if (DEPLOY_ENV === "production") {
  console.error("Cannot backfill from production to itself.");
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(
  "SELECT id, provider, cost_usd, tokens_used, created_at FROM generation_log ORDER BY created_at ASC"
).all() as { id: string; provider: string; cost_usd: number | null; tokens_used: number | null; created_at: string }[];

console.log(`[backfill] Found ${rows.length} generation_log entries in ${DB_PATH}`);
console.log(`[backfill] Reporting to ${COST_REPORT_URL} as env=${DEPLOY_ENV}`);

let sent = 0;
let skipped = 0;
let errors = 0;

for (const row of rows) {
  if (row.cost_usd == null || row.cost_usd === 0) {
    skipped++;
    continue;
  }

  try {
    const res = await fetch(COST_REPORT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cost-Report-Key": COST_REPORT_KEY,
      },
      body: JSON.stringify({
        environment: DEPLOY_ENV,
        provider: row.provider,
        cost_usd: row.cost_usd,
        tokens_used: row.tokens_used,
        description: `${row.provider} generation (${DEPLOY_ENV}, backfill)`,
        timestamp: row.created_at,
        log_id: row.id,
      }),
    });

    if (!res.ok) {
      console.error(`[backfill] HTTP ${res.status} for ${row.id}`);
      errors++;
      continue;
    }

    const data = await res.json() as { ok: boolean; created: boolean };
    if (data.created) {
      sent++;
    } else {
      skipped++; // duplicate
    }
  } catch (err) {
    console.error(`[backfill] Failed for ${row.id}:`, err);
    errors++;
  }
}

db.close();

console.log(`[backfill] Done. Sent: ${sent}, Skipped: ${skipped} (no cost or duplicate), Errors: ${errors}`);
process.exit(errors > 0 ? 1 : 0);
