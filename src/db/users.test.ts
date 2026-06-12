import { initDatabase } from './database.js';
import { upsertUserFromFirebase, createUser, setUserRole, listUsers, getUserById } from './users.js';

// Each test runs against a fresh in-memory DB (full schema + migrations), so
// the `users` table has the `role` column and is isolated per test.
describe('upsertUserFromFirebase — verified-email account reconciliation', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  it('adopts an existing verified-email account instead of creating a duplicate (preserves Admin)', () => {
    // Original account signs in with Google and is promoted to Admin.
    const google = upsertUserFromFirebase({ uid: 'uid_google', email: 'brennan@example.com', name: 'Brennan', email_verified: true });
    setUserRole(google.id, 'Admin');

    // A SECOND Firebase identity (e.g. email/password) for the same verified email.
    const second = upsertUserFromFirebase({ uid: 'uid_email', email: 'brennan@example.com', name: 'Brennan', email_verified: true });

    expect(second.id).toBe(google.id);              // same account, not a new row
    expect(second.role).toBe('Admin');               // admin preserved
    expect(second.is_admin).toBe(1);
    expect(second.firebase_uid).toBe('uid_email');   // UID re-bound onto the canonical row
    expect(listUsers()).toHaveLength(1);             // no duplicate created
  });

  it('creates a new Host when the verified email has no existing account', () => {
    const u = upsertUserFromFirebase({ uid: 'uid_new', email: 'fresh@example.com', name: 'Fresh', email_verified: true });
    expect(u.role).toBe('Host');
    expect(u.firebase_uid).toBe('uid_new');
    expect(listUsers()).toHaveLength(1);
  });

  it('does NOT adopt when the incoming email is unverified (no account takeover)', () => {
    const admin = upsertUserFromFirebase({ uid: 'uid_google', email: 'victim@example.com', name: 'Victim', email_verified: true });
    setUserRole(admin.id, 'Admin');

    // Attacker presents the victim's email but an UNVERIFIED token.
    const attacker = upsertUserFromFirebase({ uid: 'uid_attacker', email: 'victim@example.com', name: 'Eve', email_verified: false });

    expect(attacker.id).not.toBe(admin.id);          // a separate, fresh row
    expect(attacker.role).toBe('Host');              // not admin
    const original = getUserById(admin.id)!;          // original admin untouched
    expect(original.role).toBe('Admin');
    expect(original.firebase_uid).toBe('uid_google');
    expect(listUsers()).toHaveLength(2);
  });

  it('omitting email_verified is treated as unverified (no adopt)', () => {
    const admin = upsertUserFromFirebase({ uid: 'uid_google', email: 'a@example.com', name: 'A', email_verified: true });
    setUserRole(admin.id, 'Admin');
    const second = upsertUserFromFirebase({ uid: 'uid_email', email: 'a@example.com', name: 'A' });
    expect(second.id).not.toBe(admin.id);
    expect(second.role).toBe('Host');
    expect(listUsers()).toHaveLength(2);
  });

  it('tie-breaks to the Admin account when multiple same-email rows exist', () => {
    // Seed two same-email rows: an Admin (uid1) and a Host (uid2). The Host row
    // is created via the unverified path so reconciliation does not fold it in.
    const adminRow = upsertUserFromFirebase({ uid: 'uid1', email: 'dupe@example.com', name: 'A', email_verified: true });
    setUserRole(adminRow.id, 'Admin');
    const hostRow = upsertUserFromFirebase({ uid: 'uid2', email: 'dupe@example.com', name: 'B', email_verified: false });
    expect(listUsers()).toHaveLength(2);

    // A new verified identity for the same email should adopt the ADMIN row.
    const adopted = upsertUserFromFirebase({ uid: 'uid3', email: 'dupe@example.com', name: 'A again', email_verified: true });
    expect(adopted.id).toBe(adminRow.id);
    expect(adopted.role).toBe('Admin');
    expect(adopted.firebase_uid).toBe('uid3');
    expect(getUserById(hostRow.id)!.firebase_uid).toBe('uid2'); // unrelated Host left as-is
  });

  it('updates the existing row (no new account) when the same UID signs in again', () => {
    const first = upsertUserFromFirebase({ uid: 'uid_same', email: 'same@example.com', name: 'First', email_verified: true });
    const again = upsertUserFromFirebase({ uid: 'uid_same', email: 'same@example.com', name: 'First Updated', email_verified: true });
    expect(again.id).toBe(first.id);
    expect(again.display_name).toBe('First Updated');
    expect(listUsers()).toHaveLength(1);
  });

  it('matches email case-insensitively when adopting', () => {
    const orig = upsertUserFromFirebase({ uid: 'uid_a', email: 'Mixed@Example.com', name: 'Mixed', email_verified: true });
    setUserRole(orig.id, 'Admin');
    const second = upsertUserFromFirebase({ uid: 'uid_b', email: 'mixed@example.com', name: 'Mixed', email_verified: true });
    expect(second.id).toBe(orig.id);
    expect(second.role).toBe('Admin');
    expect(listUsers()).toHaveLength(1);
  });

  it('creates a nameless account (blank display_name, not "User") when the token has no name', () => {
    const u = upsertUserFromFirebase({ uid: 'uid_noname', email: 'noname@example.com', email_verified: true });
    expect(u.display_name).toBe('');
    expect(u.firebase_uid).toBe('uid_noname');
  });
});

describe('createUser — empty display_name never overwrites an existing name', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  it('keeps the existing name when upserting the same UID with an empty display_name', () => {
    const first = createUser({ display_name: 'Brennan', firebase_uid: 'uid_keep' });
    const again = createUser({ display_name: '', firebase_uid: 'uid_keep' });
    expect(again.id).toBe(first.id);
    expect(again.display_name).toBe('Brennan'); // NULLIF('','') → COALESCE keeps existing
    expect(listUsers()).toHaveLength(1);
  });

  it('still updates to a new non-empty name', () => {
    createUser({ display_name: 'Old', firebase_uid: 'uid_upd' });
    const updated = createUser({ display_name: 'New', firebase_uid: 'uid_upd' });
    expect(updated.display_name).toBe('New');
  });
});
