// CarkedIt API — Partner-brand ("Champion") data access.
//
// One brand = one vanity URL (slug). Only status='approved' brands resolve
// their slug to a co-branded page. A game's brand is DERIVED elsewhere via
// games.host_user_id → users.brand_id (no games column), so nothing here
// touches games.
import { randomUUID } from 'node:crypto';
import { getDb } from './database.js';
import { validateBrandSlug } from '../config/brand-config.js';
import type { Brand, BrandStatus, BrandWithOwner } from './types.js';

export function createBrand(data: {
  slug: string;
  name: string;
  owner_user_id: string;
  logo_url?: string | null;
  status?: BrandStatus;
  plan?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
}): Brand {
  const db = getDb();
  const id = `brand_${randomUUID()}`;
  db.prepare(`
    INSERT INTO brands (id, slug, name, logo_url, owner_user_id, status, plan, contact_email, contact_phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.slug, data.name, data.logo_url ?? null, data.owner_user_id,
    data.status ?? 'pending', data.plan ?? null,
    data.contact_email ?? null, data.contact_phone ?? null,
  );
  return db.prepare('SELECT * FROM brands WHERE id = ?').get(id) as Brand;
}

/**
 * Owner edit of a brand request. Updates only the provided columns (among
 * name/slug/plan/contact_email/contact_phone/logo_url), bumps updated_at, and
 * leaves `status` untouched. Returns the updated row (or null if id not found).
 */
export function updateBrand(
  id: string,
  fields: Partial<Pick<Brand, 'name' | 'slug' | 'plan' | 'contact_email' | 'contact_phone' | 'logo_url'>>,
): Brand | null {
  const db = getDb();
  const allowed = ['name', 'slug', 'plan', 'contact_email', 'contact_phone', 'logo_url'] as const;
  const cols = allowed.filter((c) => Object.prototype.hasOwnProperty.call(fields, c));
  if (cols.length === 0) return getBrandById(id);
  const setClause = cols.map((c) => `${c} = ?`).join(', ');
  const values = cols.map((c) => (fields as Record<string, unknown>)[c] ?? null);
  const info = db
    .prepare(`UPDATE brands SET ${setClause}, updated_at = datetime('now') WHERE id = ?`)
    .run(...values, id);
  if (info.changes === 0) return null;
  return getBrandById(id);
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

/**
 * Brands (optionally filtered by status) enriched with the owner's display name
 * + email via a LEFT JOIN — so the admin review UI shows WHO requested a brand,
 * not just an opaque owner id. Owner columns are null if the user row is gone.
 */
export function listBrandsWithOwner(status?: BrandStatus): BrandWithOwner[] {
  const db = getDb();
  const base = `
    SELECT b.*, u.display_name AS owner_display_name, u.email AS owner_email
    FROM brands b
    LEFT JOIN users u ON u.id = b.owner_user_id
  `;
  if (status) {
    return db.prepare(`${base} WHERE b.status = ? ORDER BY b.created_at DESC`).all(status) as BrandWithOwner[];
  }
  return db.prepare(`${base} ORDER BY b.created_at DESC`).all() as BrandWithOwner[];
}

/**
 * Is a candidate slug available for a new brand request? Reuses
 * validateBrandSlug (format + reserved guard) then checks uniqueness against
 * existing brands of ANY status (a pending request already holds its slug).
 * `reserved` should be the live buildReservedSlugs(clientDir) set; when omitted
 * validateBrandSlug falls back to the static reserved set.
 */
export function getSlugAvailability(
  raw: string,
  reserved?: ReadonlySet<string>,
): { available: boolean; reason?: string } {
  const check = validateBrandSlug(raw, reserved);
  if (!check.ok) return { available: false, reason: check.error };
  if (getBrandBySlug(check.slug)) {
    return { available: false, reason: 'That URL is already taken' };
  }
  return { available: true };
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

/**
 * Accounts attribution-tagged to a brand (users.brand_id), newest first.
 * PII-limited — only id / display_name / created_at, never email or firebase_uid
 * — for the owner-gated brand-admin "signed-up accounts" panel.
 */
export function listBrandUsers(brandId: string): Array<{ id: string; display_name: string; created_at: string }> {
  const db = getDb();
  return db.prepare(
    'SELECT id, display_name, created_at FROM users WHERE brand_id = ? ORDER BY created_at DESC',
  ).all(brandId) as Array<{ id: string; display_name: string; created_at: string }>;
}
