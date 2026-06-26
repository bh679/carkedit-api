import fs from 'node:fs';
import {
  SLUG_REGEX,
  isValidSlugFormat,
  normalizeSlug,
  validateBrandSlug,
  buildReservedSlugs,
  STATIC_RESERVED_SLUGS,
  RESERVED_PREFIXES,
} from './brand-config.js';

// Mirror of carkedit-online/js/config/pages.js PAGES paths. The reserved-slug
// guard MUST reject every standalone page so a partner vanity URL can never
// shadow one. (Kept in sync with pages.js; buildReservedSlugs() additionally
// unions the live client dir's *.html basenames as a drift backstop.)
const PAGE_PATHS = [
  'index', 'admin-image-gen', 'admin-users', 'admin-roles', 'card-scale-test',
  'card-test', 'color-demo', 'deploy', 'deploying', 'dev-dashboard', 'expansions',
  'financial-dashboard', 'mockup-menu-layouts', 'stats', 'stats-games',
  'stats-surveys', 'text-card-test',
];
// Root *.html files that exist but are NOT in PAGES — the easy-to-miss case.
const ROOT_HTML_NOT_IN_PAGES = ['how-to-play'];

describe('brand slug format', () => {
  it('accepts valid slugs', () => {
    for (const s of ['acme', 'death-co', 'a1', 'my-brand-2', 'x'.repeat(40)]) {
      expect(isValidSlugFormat(s)).toBe(true);
      expect(SLUG_REGEX.test(s)).toBe(true);
    }
  });

  it('rejects malformed slugs (case, length, charset)', () => {
    for (const s of ['', 'a', 'Acme', 'has space', 'under_score', 'slash/y', 'x'.repeat(41), 'café', 'dot.dot']) {
      expect(isValidSlugFormat(s)).toBe(false);
    }
  });

  it('normalizes case + surrounding whitespace', () => {
    expect(normalizeSlug('  ACME  ')).toBe('acme');
    expect(normalizeSlug('Death-Co')).toBe('death-co');
  });
});

describe('reserved-slug guard', () => {
  it('reserves every standalone page path (PAGES + root .html not in PAGES)', () => {
    for (const p of [...PAGE_PATHS, ...ROOT_HTML_NOT_IN_PAGES]) {
      const result = validateBrandSlug(p);
      expect(result.ok).toBe(false);
    }
  });

  it('reserves every reserved prefix word', () => {
    for (const p of RESERVED_PREFIXES) {
      expect(STATIC_RESERVED_SLUGS.has(p)).toBe(true);
    }
  });

  it('reserves the new brand-feature pages', () => {
    for (const p of ['brand-admin', 'admin-brands', 'brand-signup', 'brands']) {
      expect(validateBrandSlug(p).ok).toBe(false);
    }
  });

  it('reserves generic brand / organisation words and their synonyms', () => {
    for (const p of [
      'brand', 'brands', 'branding', 'partner', 'partners', 'sponsor',
      'evangelist', 'evangelists',
      'organization', 'organizations', 'organisation', 'org', 'orgs',
      'company', 'companies', 'business', 'agency', 'team', 'group', 'enterprise',
      'foundation', 'charity', 'nonprofit', 'institution', 'association',
    ]) {
      expect(validateBrandSlug(p).ok).toBe(false);
    }
  });

  it('reserves generic app + game words', () => {
    for (const p of [
      'id', 'new', 'restart', 'menu', 'home', 'settings', 'login', 'signup', 'profile',
      'game', 'games', 'play', 'player', 'players', 'lobby', 'room', 'round',
      'score', 'leaderboard', 'start', 'pause', 'quit', 'rules', 'deck', 'cards',
      'hand', 'turn', 'phase', 'eulogy', 'die', 'live', 'bye', 'wildcard',
    ]) {
      expect(validateBrandSlug(p).ok).toBe(false);
    }
  });

  it('allows a normal, unreserved brand slug and returns the normalized value', () => {
    const result = validateBrandSlug('  Acme-Co ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.slug).toBe('acme-co');
  });

  it('buildReservedSlugs falls back to the static set when clientDir is missing', () => {
    const set = buildReservedSlugs('/no/such/dir/xyz');
    for (const p of PAGE_PATHS) expect(set.has(p)).toBe(true);
  });

  it('buildReservedSlugs unions live *.html basenames from a real client dir', () => {
    // Point at the sibling client repo if present; skip silently otherwise so
    // the test is robust in CI checkouts that don't include the client.
    const candidates = [
      `${process.cwd()}/../carkedit-online`,
      `${process.cwd()}/../../carkedit-online`,
    ];
    const dir = candidates.find((d) => {
      try { return fs.existsSync(`${d}/index.html`); } catch { return false; }
    });
    if (!dir) return; // client repo not checked out here — nothing to assert
    const set = buildReservedSlugs(dir);
    expect(set.has('how-to-play')).toBe(true);
    expect(set.has('index')).toBe(true);
  });
});
