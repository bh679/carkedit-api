import { randomUUID } from 'node:crypto';
import { getDb } from './database.js';
import type { User } from './types.js';

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
          display_name = COALESCE(?, display_name),
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
    INSERT INTO users (id, firebase_uid, display_name, email, avatar_url, birth_month, birth_day)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.firebase_uid ?? null, data.display_name, data.email ?? null, data.avatar_url ?? null, bm, bd);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User;
}

export function getUserById(id: string): User | null {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  return user ?? null;
}

export function upsertUserFromFirebase(firebaseUser: {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
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

  const id = `usr_${randomUUID()}`;
  db.prepare(`
    INSERT INTO users (id, firebase_uid, display_name, email, avatar_url, birth_month, birth_day)
    VALUES (?, ?, ?, ?, ?, 0, 0)
  `).run(id, firebaseUser.uid, firebaseUser.name || 'User', firebaseUser.email ?? null, firebaseUser.picture ?? null);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User;
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
  db.prepare(`UPDATE users SET is_admin = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(isAdmin ? 1 : 0, userId);
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
