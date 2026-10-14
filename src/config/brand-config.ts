// CarkedIt API — Partner-brand ("Champion") configuration.
//
// Single source of truth for three things the brand feature needs server-side:
//   1. The configurable role DISPLAY LABEL. The product name may change
//      ("Champion" → something else) — rename it HERE, in one place.
//      Code identifiers stay neutral (`brand` / `champion`).
//   2. The brand-slug FORMAT rule (what a carkedit.com/<slug> may look like).
//   3. The RESERVED-SLUG guard that stops a partner vanity URL from shadowing
//      a real page, asset, or API path.
//
// NOTE: the slug resolver is also mounted AFTER express.static and every /api
// route, so a real file/route always wins regardless of this list. The reserved
// set is the creation-time guard plus defence-in-depth for prefix-y words.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reserved-slug word lists live in reserved-slugs.json (single source of truth,
 * also usable by other tooling). Read at load via fs so it works under plain
 * `tsc` + Node ESM (no JSON import-attribute coupling); the file is copied to
 * dist by the build step. Grouping is for readability only — everything is
 * unioned into one exact-match set below.
 */
const RESERVED_DATA = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'reserved-slugs.json'), 'utf8'),
) as { prefixes: string[]; pages: string[]; brandWords: string[]; appWords: string[]; gameWords: string[] };

/**
 * Display label for the partner-brand role. Change it HERE (and mirror in
 * carkedit-online/js/config/brand-labels.js) — never hardcode it inline.
 */
export const ROLE_LABELS = {
  champion: { singular: 'Champion', plural: 'Champions' },
} as const;

/** Brand slug format: 2–40 chars of lowercase letters, digits, and hyphens. */
export const SLUG_REGEX = /^[a-z0-9-]{2,40}$/;

/**
 * Path prefixes a brand slug may never take — these are (or proxy to) real
 * server mounts / asset roots.
 */
/**
 * Path prefixes a brand slug may never take — these are (or proxy to) real
 * server mounts / asset roots. ('admin' is also the owner-panel second segment.)
 */
export const RESERVED_PREFIXES: readonly string[] = RESERVED_DATA.prefixes;

/**
 * Standalone pages + generic brand / organisation / app / game words that must
 * never be claimable as a slug (see reserved-slugs.json). buildReservedSlugs()
 * additionally unions the live client dir's *.html basenames, so future pages
 * are covered without editing the JSON.
 */
export const RESERVED_PAGE_SLUGS: readonly string[] = [
  ...RESERVED_DATA.pages,
  ...RESERVED_DATA.brandWords,
  ...RESERVED_DATA.appWords,
  ...RESERVED_DATA.gameWords,
];

/** The always-on reserved set, independent of any filesystem scan. */
export const STATIC_RESERVED_SLUGS: ReadonlySet<string> = new Set([
  ...RESERVED_PREFIXES,
  ...RESERVED_PAGE_SLUGS,
]);

/**
 * Effective reserved-slug set: the static set above unioned with the basenames
 * of every top-level *.html file actually served from `clientDir`, so a new
 * client page is auto-reserved without editing this file. Filesystem errors
 * degrade gracefully to the static set.
 */
export function buildReservedSlugs(clientDir?: string): Set<string> {
  const reserved = new Set(STATIC_RESERVED_SLUGS);
  if (clientDir) {
    try {
      for (const entry of fs.readdirSync(clientDir)) {
        if (entry.toLowerCase().endsWith('.html')) {
          reserved.add(path.basename(entry, path.extname(entry)).toLowerCase());
        }
      }
    } catch {
      /* dir missing/unreadable — the static set is a safe fallback */
    }
  }
  return reserved;
}

/** True when `slug` matches the format rule (does not check reservation). */
export function isValidSlugFormat(slug: string): boolean {
  return typeof slug === 'string' && SLUG_REGEX.test(slug);
}

/** Canonical slug form: trimmed + lowercased. */
export function normalizeSlug(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

export type SlugValidation = { ok: true; slug: string } | { ok: false; error: string };

/**
 * Validate a candidate slug for brand creation: format first, then reservation.
 * `reserved` defaults to the static set; callers with a clientDir should pass
 * buildReservedSlugs(clientDir) so live pages are also covered.
 */
export function validateBrandSlug(
  raw: string,
  reserved: ReadonlySet<string> = STATIC_RESERVED_SLUGS,
): SlugValidation {
  const slug = normalizeSlug(raw);
  if (!isValidSlugFormat(slug)) {
    return { ok: false, error: 'Slug must be 2–40 characters: lowercase letters, numbers, and hyphens only.' };
  }
  if (reserved.has(slug)) {
    return { ok: false, error: `"${slug}" is a reserved path and cannot be used as a brand URL.` };
  }
  return { ok: true, slug };
}
