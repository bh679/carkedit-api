// CarkedIt API — cost_entries DB helpers.
//
// Unified cost storage for all sources: remote environment reports
// (staging/local → production), AWS, Cloudflare, manual entries, etc.
//
// Idempotent inserts via UNIQUE source_ref — safe to POST the same
// cost twice (backfill re-runs, network retries).

import { randomUUID } from "node:crypto";
import { getDb } from "./database.js";
import type { CostEntry } from "./types.js";

/**
 * Insert a cost entry. Uses INSERT OR IGNORE so duplicate `source_ref`
 * values are silently skipped (idempotent).
 *
 * Returns the entry if created, or null if it was a duplicate.
 */
export function createCostEntry(entry: {
  service: string;
  category: string;
  description: string;
  amount_usd: number;
  period_start: string;
  period_end: string;
  environment?: string;
  source?: string;
  source_ref?: string | null;
  entered_by?: string | null;
}): CostEntry | null {
  const db = getDb();
  const id = `cost_${randomUUID()}`;
  const result = db.prepare(
    `INSERT OR IGNORE INTO cost_entries
      (id, service, category, description, amount_usd, period_start, period_end, environment, source, source_ref, entered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    entry.service,
    entry.category,
    entry.description,
    entry.amount_usd,
    entry.period_start,
    entry.period_end,
    entry.environment ?? "production",
    entry.source ?? "manual",
    entry.source_ref ?? null,
    entry.entered_by ?? null,
  );
  if (result.changes === 0) return null; // duplicate source_ref
  return db
    .prepare("SELECT * FROM cost_entries WHERE id = ?")
    .get(id) as CostEntry;
}

/**
 * List cost entries with optional filters, newest first.
 */
export function listCostEntries(opts: {
  service?: string;
  source?: string;
  environment?: string;
  from?: string;   // period_start >= from
  to?: string;     // period_end <= to
  limit?: number;
  offset?: number;
} = {}): CostEntry[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const clauses: string[] = [];
  const params: any[] = [];

  if (opts.service) { clauses.push("service = ?"); params.push(opts.service); }
  if (opts.source) { clauses.push("source = ?"); params.push(opts.source); }
  if (opts.environment) { clauses.push("environment = ?"); params.push(opts.environment); }
  if (opts.from) { clauses.push("period_start >= ?"); params.push(opts.from); }
  if (opts.to) { clauses.push("period_end <= ?"); params.push(opts.to); }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit, offset);

  return db.prepare(
    `SELECT * FROM cost_entries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params) as CostEntry[];
}

/**
 * Aggregate cost entries by service and month.
 */
export function getCostSummaryByService(opts: {
  from?: string;
  to?: string;
} = {}): { service: string; month: string; total_usd: number; count: number }[] {
  const db = getDb();

  const clauses: string[] = [];
  const params: any[] = [];

  if (opts.from) { clauses.push("period_start >= ?"); params.push(opts.from); }
  if (opts.to) { clauses.push("period_end <= ?"); params.push(opts.to); }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  return db.prepare(
    `SELECT service, strftime('%Y-%m', period_start) as month,
            SUM(amount_usd) as total_usd, COUNT(*) as count
     FROM cost_entries ${where}
     GROUP BY service, month ORDER BY month DESC, total_usd DESC`
  ).all(...params) as any[];
}

/**
 * Aggregate cost entries by environment (for the dashboard breakdown).
 */
export function getCostByEnvironment(): { environment: string; total_usd: number; count: number }[] {
  const db = getDb();
  return db.prepare(
    `SELECT environment, SUM(amount_usd) as total_usd, COUNT(*) as count
     FROM cost_entries WHERE service = 'image_gen'
     GROUP BY environment ORDER BY total_usd DESC`
  ).all() as any[];
}
