/**
 * Operator-configured admin allowlist.
 *
 * `ADMIN_EMAILS` (env) holds the addresses that should always hold the `Admin`
 * role, so a freshly-provisioned or rebuilt database re-grants the owner on
 * their next *verified* sign-in instead of stranding them as a `Host`.
 *
 * Value is a comma / whitespace / newline separated list, e.g.
 *   ADMIN_EMAILS="owner@example.com, ops@example.com"
 *
 * Read at call time (not module load) so the value can be overridden in tests
 * and picked up after a `pm2 restart --update-env`. Matching is exact and
 * case-insensitive: `owner+tag@x` is NOT `owner@x` — plus-addressing is a
 * distinct identity and collapsing it would be an admin-escalation vector.
 */

export function parseAdminEmails(raw: string | undefined = process.env.ADMIN_EMAILS): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return parseAdminEmails().has(email.trim().toLowerCase());
}
