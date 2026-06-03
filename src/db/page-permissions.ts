import { getDb } from './database.js';
import { ROLES, type Role } from '../auth/roles.js';

export interface PagePermission {
  path: string;
  min_role: Role;
  updated_at: string;
  updated_by_user_id: string | null;
}

export function listPagePermissions(): PagePermission[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT path, min_role, updated_at, updated_by_user_id FROM page_permissions ORDER BY path'
  ).all() as PagePermission[];
  return rows.filter((r) => (ROLES as readonly string[]).includes(r.min_role));
}

export function setPagePermission(path: string, minRole: Role, userId: string | null): PagePermission {
  const db = getDb();
  if (!(ROLES as readonly string[]).includes(minRole)) {
    throw new Error(`Invalid role: ${minRole}`);
  }
  if (!path || typeof path !== 'string' || path.length > 200) {
    throw new Error('Invalid path');
  }
  db.prepare(`
    INSERT INTO page_permissions (path, min_role, updated_at, updated_by_user_id)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(path) DO UPDATE SET
      min_role = excluded.min_role,
      updated_at = excluded.updated_at,
      updated_by_user_id = excluded.updated_by_user_id
  `).run(path, minRole, userId);
  return db.prepare(
    'SELECT path, min_role, updated_at, updated_by_user_id FROM page_permissions WHERE path = ?'
  ).get(path) as PagePermission;
}
