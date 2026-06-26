import { initDatabase } from './database.js';
import { createUser } from './users.js';
import {
  createBrand,
  updateBrand,
  getBrandBySlug,
  getApprovedBrandBySlug,
  listBrands,
  listBrandsByOwner,
  listBrandsWithOwner,
  listBrandUsers,
  getSlugAvailability,
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

  it('stores the chosen plan and defaults it to null', () => {
    const owner = makeOwner();
    const pro = createBrand({ slug: 'pro-co', name: 'Pro Co', owner_user_id: owner.id, plan: 'pro' });
    expect(pro.plan).toBe('pro');
    expect(getBrandBySlug('pro-co')?.plan).toBe('pro');

    // Omitted plan persists as null (e.g. signups not coming from the pricing page).
    const none = createBrand({ slug: 'none-co', name: 'None Co', owner_user_id: owner.id });
    expect(none.plan).toBeNull();
  });

  it('stores contact email + phone, defaulting to null when omitted', () => {
    const owner = makeOwner();
    const withContact = createBrand({
      slug: 'contact-co', name: 'Contact Co', owner_user_id: owner.id,
      contact_email: 'owner@example.com', contact_phone: '+61 400 000 000',
    });
    expect(withContact.contact_email).toBe('owner@example.com');
    expect(withContact.contact_phone).toBe('+61 400 000 000');
    const stored = getBrandBySlug('contact-co');
    expect(stored?.contact_email).toBe('owner@example.com');
    expect(stored?.contact_phone).toBe('+61 400 000 000');

    const none = createBrand({ slug: 'plain-co', name: 'Plain Co', owner_user_id: owner.id });
    expect(none.contact_email).toBeNull();
    expect(none.contact_phone).toBeNull();
  });

  it('updateBrand edits provided fields and leaves status untouched', () => {
    const owner = makeOwner();
    const b = createBrand({
      slug: 'edit-co', name: 'Edit Co', owner_user_id: owner.id, status: 'approved', plan: 'basic',
      contact_email: 'a@example.com', contact_phone: '111',
    });
    const updated = updateBrand(b.id, {
      name: 'Edited Co', slug: 'edited-co', plan: 'pro',
      contact_email: 'b@example.com', contact_phone: '222',
    });
    expect(updated?.name).toBe('Edited Co');
    expect(updated?.slug).toBe('edited-co');
    expect(updated?.plan).toBe('pro');
    expect(updated?.contact_email).toBe('b@example.com');
    expect(updated?.contact_phone).toBe('222');
    // Status is preserved across an owner edit.
    expect(updated?.status).toBe('approved');
    // Persisted under the new slug.
    expect(getBrandBySlug('edited-co')?.id).toBe(b.id);
  });

  it('updateBrand only touches the columns provided', () => {
    const owner = makeOwner();
    const b = createBrand({ slug: 'partial-co', name: 'Partial Co', owner_user_id: owner.id, plan: 'ultimate' });
    const updated = updateBrand(b.id, { contact_phone: '999' });
    expect(updated?.contact_phone).toBe('999');
    expect(updated?.name).toBe('Partial Co'); // untouched
    expect(updated?.plan).toBe('ultimate');   // untouched
  });

  it('updateBrand returns null for an unknown id', () => {
    expect(updateBrand('brand_missing', { name: 'x' })).toBeNull();
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

  describe('listBrandsWithOwner', () => {
    it('enriches each brand with its owner name + email', () => {
      const owner = makeOwner();
      const brand = createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id });
      const rows = listBrandsWithOwner();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(brand.id);
      expect(rows[0].owner_display_name).toBe('Owner');
      expect(rows[0].owner_email).toBe('owner@example.com');
    });

    it('filters by status', () => {
      const owner = makeOwner();
      createBrand({ slug: 'approved-co', name: 'Approved', owner_user_id: owner.id, status: 'approved' });
      createBrand({ slug: 'pending-co', name: 'Pending', owner_user_id: owner.id });
      const pending = listBrandsWithOwner('pending');
      expect(pending.map((b) => b.slug)).toEqual(['pending-co']);
    });
  });

  describe('getSlugAvailability', () => {
    it('accepts a well-formed, unused slug', () => {
      expect(getSlugAvailability('fresh-brand')).toEqual({ available: true });
    });

    it('rejects a malformed slug with the format reason', () => {
      const res = getSlugAvailability('Bad Slug!');
      expect(res.available).toBe(false);
      expect(res.reason).toMatch(/lowercase/i);
    });

    it('rejects a reserved slug', () => {
      // 'admin-brands' is in the static reserved set (RESERVED_PAGE_SLUGS).
      const res = getSlugAvailability('admin-brands');
      expect(res.available).toBe(false);
      expect(res.reason).toMatch(/reserved/i);
    });

    it('rejects a slug already taken by a brand of any status', () => {
      const owner = makeOwner();
      // Pending request holds the slug — still unavailable to others.
      createBrand({ slug: 'taken-co', name: 'Taken', owner_user_id: owner.id, status: 'pending' });
      const res = getSlugAvailability('taken-co');
      expect(res.available).toBe(false);
      expect(res.reason).toMatch(/already taken/i);
    });

    it('honours a passed-in reserved set', () => {
      const reserved = new Set(['promo']);
      expect(getSlugAvailability('promo', reserved).available).toBe(false);
      // A slug not in the custom set (and otherwise valid/unused) is available.
      expect(getSlugAvailability('promo2', reserved)).toEqual({ available: true });
    });
  });
});
