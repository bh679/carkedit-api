import { brandAccessDecision } from './auth.js';
import type { User, Brand } from '../db/types.js';

// Pure allow/deny logic behind requireBrandOwner — testable without Firebase.
function makeUser(over: Partial<User> = {}): User {
  return {
    id: 'usr_1',
    firebase_uid: 'uid_1',
    display_name: 'User',
    email: 'u@example.com',
    avatar_url: null,
    is_admin: 0,
    role: 'Host',
    birth_month: 0,
    birth_day: 0,
    brand_id: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

function makeBrand(over: Partial<Brand> = {}): Brand {
  return {
    id: 'brand_1',
    slug: 'acme',
    name: 'Acme',
    logo_url: null,
    owner_user_id: 'usr_owner',
    status: 'approved',
    plan: null,
    contact_email: null,
    contact_phone: null,
    theme_json: null,
    custom_domain: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

describe('brandAccessDecision', () => {
  it("returns 'ok' for the brand owner", () => {
    const owner = makeUser({ id: 'usr_owner' });
    expect(brandAccessDecision(owner, makeBrand({ owner_user_id: 'usr_owner' }))).toBe('ok');
  });

  it("returns 'ok' for a global admin via the legacy is_admin column", () => {
    const admin = makeUser({ id: 'usr_other', is_admin: 1, role: 'Host' });
    expect(brandAccessDecision(admin, makeBrand({ owner_user_id: 'usr_owner' }))).toBe('ok');
  });

  it("returns 'ok' for a global admin via the role tier", () => {
    const admin = makeUser({ id: 'usr_other', is_admin: 0, role: 'Admin' });
    expect(brandAccessDecision(admin, makeBrand({ owner_user_id: 'usr_owner' }))).toBe('ok');
  });

  it("returns 'forbidden' for a non-owner, non-admin user", () => {
    const stranger = makeUser({ id: 'usr_other', is_admin: 0, role: 'QA' });
    expect(brandAccessDecision(stranger, makeBrand({ owner_user_id: 'usr_owner' }))).toBe('forbidden');
  });

  it("returns 'not_found' when the brand is missing", () => {
    expect(brandAccessDecision(makeUser(), null)).toBe('not_found');
  });

  it("returns 'forbidden' when there is no authenticated user", () => {
    expect(brandAccessDecision(undefined, makeBrand())).toBe('forbidden');
  });

  it("prioritizes not_found over forbidden (missing brand even for a stranger)", () => {
    const stranger = makeUser({ id: 'usr_other' });
    expect(brandAccessDecision(stranger, null)).toBe('not_found');
  });
});
