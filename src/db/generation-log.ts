// CarkedIt API — generation_log DB helpers.
//
// One row per click of Generate on the admin-image-gen test page.
// The row captures the card form fields + the locally-downloaded
// image URL so the Recent generations gallery can replay it even
// after the provider's signed URL has expired.
//
// Kept in its own module so the table can grow independently of
// expansion_cards (which is the real gameplay deck).

import { randomUUID } from "node:crypto";
import { getDb } from "./database.js";
import type { GenerationLogEntry } from "./types.js";

export function createGenerationLog(entry: {
  creator_id?: string | null;
  deck_type: string;
  text?: string;
  prompt?: string | null;
  card_special?: string | null;
  options_json?: string | null;
  image_url: string;
  image_url_b?: string | null;
  provider: string;
  prompt_sent: string;
}): GenerationLogEntry {
  const db = getDb();
  const id = `gen_${randomUUID()}`;
  db.prepare(
    `INSERT INTO generation_log
      (id, creator_id, deck_type, text, prompt, card_special, options_json, image_url, image_url_b, provider, prompt_sent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    entry.creator_id ?? null,
    entry.deck_type,
    entry.text ?? "",
    entry.prompt ?? null,
    entry.card_special ?? null,
    entry.options_json ?? null,
    entry.image_url,
    entry.image_url_b ?? null,
    entry.provider,
    entry.prompt_sent,
  );
  return db
    .prepare("SELECT * FROM generation_log WHERE id = ?")
    .get(id) as GenerationLogEntry;
}

/**
 * List generation log rows, newest first.
 *
 * - `limit` defaults to 50, capped at 200
 * - `offset` for pagination (default 0)
 * - `creator_id` filters to a single author (used by scope='mine')
 */
export function listGenerationLog(opts: {
  creator_id?: string | null;
  limit?: number;
  offset?: number;
} = {}): GenerationLogEntry[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  if (opts.creator_id) {
    return db
      .prepare(
        `SELECT * FROM generation_log
         WHERE creator_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(opts.creator_id, limit, offset) as GenerationLogEntry[];
  }
  return db
    .prepare(
      `SELECT * FROM generation_log
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as GenerationLogEntry[];
}

export function getGenerationLog(id: string): GenerationLogEntry | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM generation_log WHERE id = ?")
    .get(id) as GenerationLogEntry | undefined;
  return row ?? null;
}
