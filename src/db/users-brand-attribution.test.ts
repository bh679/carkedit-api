import { initDatabase } from './database.js';
import { createUser, upsertUserFromFirebase } from './users.js';
import { createBrand } from './brands.js';

// Fresh in-memory DB per test (full schema + migrations, so users has brand_id).
describe('partner-brand signup attribution (users.brand_id)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  function seedBrand() {
    const owner = createUser({ display_name: 'Owner', firebase_uid: 'uid_owner', email: 'owner@example.com' });
    return createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id, status: 'approved' });
  }

  it('tags a brand-new Firebase account with a valid brand_id (INSERT branch)', () => {
    const brand = seedBrand();
    const user = upsertUserFromFirebase({ uid: 'uid_new', email: 'new@example.com', email_verified: true }, brand.id);
    expect(user.brand_id).toBe(brand.id);
  });

  it('never overwrites brand_id on a returning sign-in (UPDATE branch)', () => {
    const brand = seedBrand();
    const first = upsertUserFromFirebase({ uid: 'uid_ret', email: 'r@example.com', email_verified: true }, brand.id);
    expect(first.brand_id).toBe(brand.id);
    // Sign in again from the ROOT domain (no brand) — the tag must persist.
    const again = upsertUserFromFirebase({ uid: 'uid_ret', email: 'r@example.com', email_verified: true });
    expect(again.id).toBe(first.id);
    expect(again.brand_id).toBe(brand.id);
  });

  it('drops an unknown brand_id to null (advisory, not an error)', () => {
    const user = upsertUserFromFirebase({ uid: 'uid_x', email: 'x@example.com', email_verified: true }, 'brand_does_not_exist');
    expect(user.brand_id).toBeNull();
  });

  it('leaves brand_id null for a root signup (no brand context)', () => {
    const user = upsertUserFromFirebase({ uid: 'uid_root', email: 'root@example.com', email_verified: true });
    expect(user.brand_id).toBeNull();
  });

  it('createUser writes a valid brand_id on INSERT, drops an unknown one', () => {
    const brand = seedBrand();
    const tagged = createUser({ display_name: 'Anon', brand_id: brand.id });
    expect(tagged.brand_id).toBe(brand.id);
    const bogus = createUser({ display_name: 'Anon2', brand_id: 'nope' });
    expect(bogus.brand_id).toBeNull();
  });

  it('does NOT tag an adopted account (verified-email reconciliation wins; brand only set at true creation)', () => {
    // Existing account created on root (brandless) via Google.
    const google = upsertUserFromFirebase({ uid: 'uid_g', email: 'same@example.com', name: 'Same', email_verified: true });
    expect(google.brand_id).toBeNull();
    const brand = seedBrand();
    // A SECOND Firebase identity for the SAME verified email, now on a brand URL.
    const second = upsertUserFromFirebase({ uid: 'uid_e', email: 'same@example.com', name: 'Same', email_verified: true }, brand.id);
    expect(second.id).toBe(google.id);  // adopted the existing account, no duplicate
    expect(second.brand_id).toBeNull();  // adoption does not tag — not a new account
  });
});
