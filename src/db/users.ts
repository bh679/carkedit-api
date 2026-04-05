import { randomUUID } from 'node:crypto';
import { getDb } from './database.js';
import type { User } from './types.js';

export function createUser(data: {
  display_name: string;
  firebase_uid?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}): User {
  const db = getDb();
  const id = `usr_${randomUUID()}`;

  // If firebase_uid provided, try upsert
  if (data.firebase_uid) {
    const existing = db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(data.firebase_uid) as User | undefined;
    if (existing) {
      db.prepare(`
        UPDATE users SET
          display_name = COALESCE(?, display_name),
          email = COALESCE(?, email),
          avatar_url = COALESCE(?, avatar_url),
          updated_at = datetime('now')
        WHERE firebase_uid = ?
      `).run(data.display_name, data.email ?? null, data.avatar_url ?? null, data.firebase_uid);
      return db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(data.firebase_uid) as User;
    }
  }

  db.prepare(`
    INSERT INTO users (id, firebase_uid, display_name, email, avatar_url)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, data.firebase_uid ?? null, data.display_name, data.email ?? null, data.avatar_url ?? null);

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
    INSERT INTO users (id, firebase_uid, display_name, email, avatar_url)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, firebaseUser.uid, firebaseUser.name || 'User', firebaseUser.email ?? null, firebaseUser.picture ?? null);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User;
}

export function linkAnonymousUserToFirebase(anonymousUserId: string, firebaseUid: string): User | null {
  const db = getDb();

  // Check if Firebase user already has a record
  const existingFirebase = db.prepare('SELECT * FROM users WHERE firebase_uid = ?').get(firebaseUid) as User | undefined;

  if (existingFirebase) {
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
