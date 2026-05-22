/**
 * Role-based access control tiers for CarkedIt users.
 *
 * Hierarchy (low → high): Player < Host < QA < Admin.
 * A higher role inherits every permission of the roles below it.
 *
 * Players are represented by *absence* of an authenticated DB user (no row).
 * Anyone with a `users` row has at minimum the 'Host' role.
 */
export const ROLES = ['Player', 'Host', 'QA', 'Admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<Role, number> = {
  Player: 0,
  Host: 1,
  QA: 2,
  Admin: 3,
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function hasRole(user: { role?: Role | null } | null | undefined, min: Role): boolean {
  const current: Role = user?.role ?? 'Player';
  return ROLE_RANK[current] >= ROLE_RANK[min];
}
