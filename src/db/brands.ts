// CarkedIt API — Partner-brand ("Evangelist") data access.
//
// One brand = one vanity URL (slug). Only status='approved' brands resolve
// their slug to a co-branded page. A game's brand is DERIVED elsewhere via
// games.host_user_id → users.brand_id (no games column), so nothing here
// touches games.
import { randomUUID } from 'node:crypto';
import { getDb } from './database.js';
import type { Brand, BrandStatus } from './types.js';

export function createBrand(data: {
  slug: string;
  name: string;
  owner_user_id: string;
  logo_url?: string | null;
  status?: BrandStatus;
}): Brand {
  const db = getDb();
  const id = `brand_${randomUUID()}`;
  db.prepare(`
    INSERT INTO brands (id, slug, name, logo_url, owner_user_id, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, data.slug, data.name, data.logo_url ?? null, data.owner_user_id, data.status ?? 'pending');
  return db.prepare('SELECT * FROM brands WHERE id = ?').get(id) as Brand;
}

export function getBrandById(id: string): Brand | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM brands WHERE id = ?').get(id) as Brand | undefined) ?? null;
}

export function getBrandBySlug(slug: string): Brand | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM brands WHERE slug = ?').get(slug) as Brand | undefined) ?? null;
}

/** Approved brand for a slug — the public slug resolver's lookup. */
export function getApprovedBrandBySlug(slug: string): Brand | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM brands WHERE slug = ? AND status = 'approved'").get(slug) as Brand | undefined) ?? null;
}

export function listBrands(status?: BrandStatus): Brand[] {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM brands WHERE status = ? ORDER BY created_at DESC').all(status) as Brand[];
  }
  return db.prepare('SELECT * FROM brands ORDER BY created_at DESC').all() as Brand[];
}

/** Brands owned by a user — for the brand-admin panel + ownership checks. */
export function listBrandsByOwner(ownerUserId: string): Brand[] {
  const db = getDb();
  return db.prepare('SELECT * FROM brands WHERE owner_user_id = ? ORDER BY created_at DESC').all(ownerUserId) as Brand[];
}

export function setBrandStatus(id: string, status: BrandStatus): Brand | null {
  const db = getDb();
  if (!getBrandById(id)) return null;
  db.prepare("UPDATE brands SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  return getBrandById(id);
}

export function setBrandLogo(id: string, logo_url: string): Brand | null {
  const db = getDb();
  if (!getBrandById(id)) return null;
  db.prepare("UPDATE brands SET logo_url = ?, updated_at = datetime('now') WHERE id = ?").run(logo_url, id);
  return getBrandById(id);
}
