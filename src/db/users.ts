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
