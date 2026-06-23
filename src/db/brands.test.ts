import { initDatabase } from './database.js';
import { createUser } from './users.js';
import {
  createBrand,
  getBrandBySlug,
  getApprovedBrandBySlug,
  listBrands,
  listBrandsByOwner,
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
});
