#!/usr/bin/env node
// Dev helper — seed an APPROVED partner brand straight into the DB so the
// co-branded /<slug> URL can be exercised locally WITHOUT the Firebase-auth'd
// request flow (POST /brands → PATCH approve). Not used in production.
//
// Usage:
//   node scripts/seed-brand.mjs <slug> "<Brand Name>" [logoUrl]
// Env:
//   CARKEDIT_DB_PATH   override the games.db path (default: ./data/games.db)
import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.CARKEDIT_DB_PATH || path.resolve(__dirname, '../data/games.db');

const slug = (process.argv[2] || '').toLowerCase();
const name = process.argv[3] || '';
const logoUrl = process.argv[4] || null;
if (!slug || !name) {
  console.error('Usage: node scripts/seed-brand.mjs <slug> "<Brand Name>" [logoUrl]');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Ensure a placeholder owner exists (the brands.owner_user_id FK target).
const ownerId = 'usr_seed_owner';
db.prepare(
  `INSERT OR IGNORE INTO users (id, firebase_uid, display_name, email, role)
   VALUES (?, NULL, 'Seed Owner', 'seed-owner@example.com', 'Host')`,
).run(ownerId);

const existing = db.prepare('SELECT id FROM brands WHERE slug = ?').get(slug);
if (existing) {
  db.prepare(
    `UPDATE brands SET name = ?, logo_url = ?, status = 'approved', updated_at = datetime('now') WHERE slug = ?`,
  ).run(name, logoUrl, slug);
  console.log(`Updated approved brand "${name}" at /${slug} (${existing.id})`);
} else {
  const id = `brand_${randomUUID()}`;
  db.prepare(
    `INSERT INTO brands (id, slug, name, logo_url, owner_user_id, status)
     VALUES (?, ?, ?, ?, ?, 'approved')`,
  ).run(id, slug, name, logoUrl, ownerId);
  console.log(`Seeded approved brand "${name}" at /${slug} (${id})`);
}
db.close();
