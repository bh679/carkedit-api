import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './database.js';
import type { User } from './types.js';
import type { Role } from '../auth/roles.js';
import { postWebhookEmbed, buildAccountCreatedEmbed } from '../services/discord/webhook.js';

const __pkgDir = path.dirname(fileURLToPath(import.meta.url));
const __apiPkg = JSON.parse(fs.readFileSync(path.join(__pkgDir, '../../package.json'), 'utf-8'));

function notifyAccountCreated(user: User, signUpMethod: 'firebase' | 'anonymous'): void {
  try {
    const embed = buildAccountCreatedEmbed({
      displayName: user.display_name,
      userId: user.id,
      signUpMethod,
      apiVersion: __apiPkg.version,
    });
    postWebhookEmbed(embed).catch(() => { /* never throws */ });
  } catch (err) {
    console.warn('[CarkedIt Users] discord notify (account created) failed:', err);
  }
}

export function createUser(data: {
  display_name: string;
  firebase_uid?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  birth_month?: number;
  birth_day?: number;
}): User {
  const db = getDb();
  const id = `usr_${randomUUID()}`;
  const bm = (data.birth_month && data.birth_month >= 1 && data.birth_month <= 12) ? data.birth_month : 0;
  const bd = (data.birth_day && data.birth_day >= 1 && data.birth_day <= 31) ? data.birth_day : 0;

  // If firebase_uid provided, try upsert
  if (data.firebase_uid) {
    const existing = db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(data.firebase_uid) as User | undefined;
    if (existing) {
      db.prepare(`
        UPDATE users SET
          display_name = COALESCE(NULLIF(?, ''), display_name),
          email = COALESCE(?, email),
          avatar_url = COALESCE(?, avatar_url),
          birth_month = ?,
          birth_day = ?,
          updated_at = datetime('now')
        WHERE firebase_uid = ?
      `).run(data.display_name, data.email ?? null, data.avatar_url ?? null, bm || existing.birth_month, bd || existing.birth_day, data.firebase_uid);
      return db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(data.firebase_uid) as User;
    }
  }

  db.prepare(`
    INSERT INTO users (id, firebase_uid, display_name, email, avatar_url, birth_month, birth_day, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Host')
  `).run(id, data.firebase_uid ?? null, data.display_name, data.email ?? null, data.avatar_url ?? null, bm, bd);

  const created = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User;
  notifyAccountCreated(created, data.firebase_uid ? 'firebase' : 'anonymous');
  return created;
}

export function getUserById(id: string): User | null {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  return user ?? null;
}

/**
 * Account reconciliation by verified email.
 *
 * When a Firebase sign-in presents a `firebase_uid` we have never seen, but
 * whose VERIFIED email already belongs to an existing account, bind the new
 * UID onto that account instead of minting a duplicate `Host` row. Firebase
 * issues a distinct UID per identity, so without this a second sign-in method
 * for the same person (e.g. Google + email/password) silently creates a fresh
 * account and orphans their real role/admin.
 *
 * Security: only ever reconciles when `email_verified` is true, so an
 * UNVERIFIED email/password signup can never adopt (take over) someone else's
 * account. Callers MUST pass the email + verification flag straight from the
 * decoded Firebase token, never a client-supplied value.
 *
 * Returns the adopted (re-bound) row, or null when there is no safe match.
 */
function adoptAccountByVerifiedEmail(params: {
  firebase_uid: string;
  email?: string | null;
  email_verified?: boolean;
  display_name?: string | null;
  avatar_url?: string | null;
}): User | null {
  const { firebase_uid, email, email_verified, display_name, avatar_url } = params;
  if (!email || !email_verified) return null;

  const db = getDb();
  // Strongest same-email account wins: admins first, then by role rank, then
  // oldest. Skip any row already bound to this UID.
  const canonical = db.prepare(`
    SELECT * FROM users
    WHERE lower(email) = lower(?) AND (firebase_uid IS NULL OR firebase_uid != ?)
    ORDER BY is_admin DESC,
             CASE role WHEN 'Admin' THEN 3 WHEN 'QA' THEN 2 WHEN 'Host' THEN 1 ELSE 0 END DESC,
             created_at ASC
    LIMIT 1
  `).get(email, firebase_uid) as User | undefined;
  if (!canonical) return null;

  // Re-bind this UID onto the canonical account and refresh profile fields,
  // but never touch role / is_admin.
  db.prepare(`
    UPDATE users SET
      firebase_uid = ?,
      display_name = COALESCE(?, display_name),
      avatar_url = COALESCE(?, avatar_url),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(firebase_uid, display_name ?? null, avatar_url ?? null, canonical.id);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(canonical.id) as User;
}

export function upsertUserFromFirebase(firebaseUser: {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
}): User {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(firebaseUser.uid) as User | undefined;

  if (existing) {
    db.prepare(`
      UPDATE users SET
        display_name = COALESCE(?, display_name),
        email = COALESCE(?, email),
        avatar_url = COALESCE(?, avatar_url),
        updated_at = datetime('now')
      WHERE firebase_uid = ?
    `).run(firebaseUser.name ?? null, firebaseUser.email ?? null, firebaseUser.picture ?? null, firebaseUser.uid);
    return db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(firebaseUser.uid) as User;
  }

  // No row for this UID yet. Before creating one, try to adopt an existing
  // account that owns this verified email — prevents a second Firebase identity
  // (e.g. email/password vs Google) from orphaning the user's role/admin.
  const adopted = adoptAccountByVerifiedEmail({
    firebase_uid: firebaseUser.uid,
    email: firebaseUser.email,
    email_verified: firebaseUser.email_verified,
    display_name: firebaseUser.name,
    avatar_url: firebaseUser.picture,
  });
  if (adopted) return adopted;

  const id = `usr_${randomUUID()}`;
  db.prepare(`
    INSERT INTO users (id, firebase_uid, display_name, email, avatar_url, birth_month, birth_day, role)
    VALUES (?, ?, ?, ?, ?, 0, 0, 'Host')
  `).run(id, firebaseUser.uid, firebaseUser.name || '', firebaseUser.email ?? null, firebaseUser.picture ?? null);

  const created = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User;
  notifyAccountCreated(created, 'firebase');
  return created;
}

export function updateUserProfile(id: string, data: {
  display_name?: string;
  birth_month?: number;
  birth_day?: number;
}): User | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  if (!existing) return null;

  const name = data.display_name?.trim() || existing.display_name;
  const bm = (data.birth_month !== undefined && data.birth_month >= 0 && data.birth_month <= 12) ? data.birth_month : existing.birth_month;
  const bd = (data.birth_day !== undefined && data.birth_day >= 0 && data.birth_day <= 31) ? data.birth_day : existing.birth_day;

  db.prepare(`
    UPDATE users SET display_name = ?, birth_month = ?, birth_day = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, bm, bd, id);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User;
}

export function listUsers(): User[] {
  const db = getDb();
  return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as User[];
}

export function hasAnyAdmin(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin = 1').get() as { c: number };
  return row.c > 0;
}

export function setAdminFlag(userId: string, isAdmin: boolean): User | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;
  if (!existing) return null;
  // Dual-write: keep is_admin and role aligned during the deprecation window.
  // Promoting → Admin; demoting → Host (the baseline for signed-up users).
  const nextRole: Role = isAdmin ? 'Admin' : 'Host';
  db.prepare(`UPDATE users SET is_admin = ?, role = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(isAdmin ? 1 : 0, nextRole, userId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User;
}

export function setUserRole(userId: string, role: Role): User | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;
  if (!existing) return null;
  // Dual-write is_admin so legacy code paths still see admin status until the
  // column is dropped in a follow-up patch.
  const isAdmin = role === 'Admin' ? 1 : 0;
  db.prepare(`UPDATE users SET role = ?, is_admin = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(role, isAdmin, userId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User;
}

export function linkAnonymousUserToFirebase(anonymousUserId: string, firebaseUid: string): User | null {
  const db = getDb();

  // Check if Firebase user already has a record
  const existingFirebase = db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(firebaseUid) as User | undefined;

  if (existingFirebase) {
    // Already linked — same user, just return
    if (existingFirebase.id === anonymousUserId) {
      return existingFirebase;
    }
    // Migrate packs from anonymous to existing Firebase user
    const transaction = db.transaction(() => {
      db.prepare('UPDATE expansion_packs SET creator_id = ? WHERE creator_id = ?')
        .run(existingFirebase.id, anonymousUserId);
      db.prepare('DELETE FROM users WHERE id = ?').run(anonymousUserId);
    });
    transaction();
    return existingFirebase;
  }

  // Link anonymous record to Firebase
  const anonymousUser = db.prepare('SELECT * FROM users WHERE id = ?').get(anonymousUserId) as User | undefined;
  if (!anonymousUser) return null;

  db.prepare('UPDATE users SET firebase_uid = ?, updated_at = datetime("now") WHERE id = ?')
    .run(firebaseUid, anonymousUserId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(anonymousUserId) as User;
}
