import { initDatabase } from './database.js';
import { createUser } from './users.js';
import {
  createBrand,
  getBrandBySlug,
  getApprovedBrandBySlug,
  listBrands,
  listBrandsByOwner,
  listBrandUsers,
  setBrandStatus,
  setBrandLogo,
} from './brands.js';

// Each test runs against a fresh in-memory DB (full schema incl. the brands
// table + FK enforcement), isolated per test.
describe('brands data access', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  function makeOwner() {
    return createUser({ display_name: 'Owner', firebase_uid: 'uid_owner', email: 'owner@example.com' });
  }

  it('creates a brand pending by default and finds it by slug', () => {
    const owner = makeOwner();
    const brand = createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id });
    expect(brand.status).toBe('pending');
    expect(brand.id).toMatch(/^brand_/);
    expect(getBrandBySlug('acme')?.id).toBe(brand.id);
    // Pending brands must NOT resolve as approved (slug stays dark until review).
    expect(getApprovedBrandBySlug('acme')).toBeNull();
  });

  it('only resolves a slug once approved', () => {
    const owner = makeOwner();
    const brand = createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id });
    setBrandStatus(brand.id, 'approved');
    expect(getApprovedBrandBySlug('acme')?.id).toBe(brand.id);
    // Suspending it takes the slug dark again.
    setBrandStatus(brand.id, 'suspended');
    expect(getApprovedBrandBySlug('acme')).toBeNull();
  });

  it('enforces slug uniqueness', () => {
    const owner = makeOwner();
    createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id });
    expect(() => createBrand({ slug: 'acme', name: 'Other', owner_user_id: owner.id })).toThrow();
  });

  it('rejects a brand with a non-existent owner (FK enforced)', () => {
    expect(() => createBrand({ slug: 'acme', name: 'Acme', owner_user_id: 'usr_missing' })).toThrow();
  });

  it('lists by status and by owner, and updates the logo', () => {
    const owner = makeOwner();
    const approved = createBrand({ slug: 'a-co', name: 'A', owner_user_id: owner.id, status: 'approved' });
    createBrand({ slug: 'b-co', name: 'B', owner_user_id: owner.id });
    expect(listBrands('approved').map((b) => b.id)).toEqual([approved.id]);
    expect(listBrandsByOwner(owner.id)).toHaveLength(2);

    const withLogo = setBrandLogo(approved.id, '/uploads/brands/a.png');
    expect(withLogo?.logo_url).toBe('/uploads/brands/a.png');
  });

  it('lists only brand-tagged users, newest first, PII-limited', () => {
    const owner = makeOwner();
    const brand = createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id, status: 'approved' });
    const other = createBrand({ slug: 'other', name: 'Other', owner_user_id: owner.id, status: 'approved' });

    const u1 = createUser({ display_name: 'First', firebase_uid: 'uid_1', email: 'one@example.com', brand_id: brand.id });
    const u2 = createUser({ display_name: 'Second', firebase_uid: 'uid_2', email: 'two@example.com', brand_id: brand.id });
    createUser({ display_name: 'Outsider', firebase_uid: 'uid_3', email: 'three@example.com' }); // no brand
    createUser({ display_name: 'OtherBrand', firebase_uid: 'uid_4', email: 'four@example.com', brand_id: other.id });

    const members = listBrandUsers(brand.id);
    // Only the two acme-tagged accounts (owner row itself has no brand_id).
    expect(members.map((m) => m.id).sort()).toEqual([u1.id, u2.id].sort());
    // Newest first (created_at DESC; ties resolve by insertion, so u2 ≥ u1).
    expect(new Date(members[0].created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(members[1].created_at).getTime(),
    );
    // PII-limited shape — no email / firebase_uid leaked.
    expect(Object.keys(members[0]).sort()).toEqual(['created_at', 'display_name', 'id']);
  });
});
