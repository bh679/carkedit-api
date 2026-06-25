// CarkedIt API — Partner-brand ("Evangelist") configuration.
//
// Single source of truth for three things the brand feature needs server-side:
//   1. The configurable role DISPLAY LABEL. The product name may change
//      ("Death Evangelist" → something else) — rename it HERE, in one place.
//      Code identifiers stay neutral (`brand` / `evangelist`).
//   2. The brand-slug FORMAT rule (what a carkedit.com/<slug> may look like).
//   3. The RESERVED-SLUG guard that stops a partner vanity URL from shadowing
//      a real page, asset, or API path.
//
// NOTE: the slug resolver is also mounted AFTER express.static and every /api
// route, so a real file/route always wins regardless of this list. The reserved
// set is the creation-time guard plus defence-in-depth for prefix-y words.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Display label for the partner-brand role. Change it HERE (and mirror in
 * carkedit-online/js/config/brand-labels.js) — never hardcode it inline.
 */
export const ROLE_LABELS = {
  evangelist: { singular: 'Death Evangelist', plural: 'Death Evangelists' },
} as const;

/** Brand slug format: 2–40 chars of lowercase letters, digits, and hyphens. */
export const SLUG_REGEX = /^[a-z0-9-]{2,40}$/;

/**
 * Path prefixes a brand slug may never take — these are (or proxy to) real
 * server mounts / asset roots.
 */
export const RESERVED_PREFIXES: readonly string[] = [
  'api', 'uploads', '__', 'assets', 'css', 'js', 'scripts', 'mockups', 'docs',
  'node_modules', 'tests', 'ports', 'data', 'dist',
  // 'admin' is the second segment of the owner panel (/<slug>/admin); reserving
  // it as a top-level prefix keeps a brand from claiming the bare /admin slug.
  'admin',
];

/**
 * Standalone pages + app words that must never be claimable as a slug. Mirrors
 * carkedit-online/js/config/pages.js PAGES, plus root *.html files that are NOT
 * in PAGES (e.g. how-to-play), plus the new brand pages. buildReservedSlugs()
 * additionally unions the live client dir's *.html basenames, so future pages
 * are covered without editing this list.
 */
export const RESERVED_PAGE_SLUGS: readonly string[] = [
  // carkedit-online/js/config/pages.js PAGES
  'index', 'admin-image-gen', 'admin-users', 'admin-roles', 'card-scale-test',
  'card-test', 'color-demo', 'deploy', 'deploying', 'dev-dashboard', 'expansions',
  'financial-dashboard', 'mockup-menu-layouts', 'stats', 'stats-games',
  'stats-surveys', 'text-card-test',
  // root *.html present as files but not in PAGES
  'how-to-play',
  // brand feature pages + reserved app words
  'brand-admin', 'admin-brands', 'brand-signup', 'brands', 'account', 'menu', 'host', 'join',
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
