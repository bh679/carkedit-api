import { initDatabase } from './database.js';
import { upsertUserFromFirebase, createUser, setUserRole, listUsers, getUserById } from './users.js';
import { isAdminEmail, parseAdminEmails } from '../auth/admin-emails.js';

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

describe('admin-emails — parseAdminEmails / isAdminEmail', () => {
  const ORIGINAL = process.env.ADMIN_EMAILS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = ORIGINAL;
  });

  it('parses comma / whitespace / newline separated lists, trimmed + lowercased', () => {
    const set = parseAdminEmails('  Owner@Example.com, ops@example.com\n a@b.co ');
    expect(set).toEqual(new Set(['owner@example.com', 'ops@example.com', 'a@b.co']));
  });

  it('is empty when unset or blank', () => {
    expect(parseAdminEmails(undefined).size).toBe(0);
    expect(parseAdminEmails('').size).toBe(0);
    expect(parseAdminEmails('   ').size).toBe(0);
  });

  it('matches case-insensitively and exactly — no plus-address collapsing', () => {
    process.env.ADMIN_EMAILS = 'owner@example.com';
    expect(isAdminEmail('OWNER@Example.com')).toBe(true);
    expect(isAdminEmail('owner@example.com')).toBe(true);
    expect(isAdminEmail('owner+test@example.com')).toBe(false); // distinct identity
    expect(isAdminEmail('someone@example.com')).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
  });

  it('returns false for everyone when the allowlist is unset', () => {
    delete process.env.ADMIN_EMAILS;
    expect(isAdminEmail('owner@example.com')).toBe(false);
  });
});

describe('upsertUserFromFirebase — ADMIN_EMAILS allowlist auto-grant', () => {
  const ORIGINAL = process.env.ADMIN_EMAILS;
  beforeEach(() => {
    process.env.ADMIN_EMAILS = 'owner@example.com';
    initDatabase(':memory:');
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = ORIGINAL;
  });

  it('grants Admin to a verified allowlisted email on first sign-in (fresh DB)', () => {
    const u = upsertUserFromFirebase({ uid: 'uid_owner', email: 'owner@example.com', name: 'Owner', email_verified: true });
    expect(u.role).toBe('Admin');
    expect(u.is_admin).toBe(1);
    expect(listUsers()).toHaveLength(1);
  });

  it('does NOT grant Admin when the allowlisted email is unverified (no self-promote)', () => {
    const u = upsertUserFromFirebase({ uid: 'uid_owner', email: 'owner@example.com', name: 'Owner', email_verified: false });
    expect(u.role).toBe('Host');
    expect(u.is_admin).toBe(0);
  });

  it('treats missing email_verified as unverified (no grant)', () => {
    const u = upsertUserFromFirebase({ uid: 'uid_owner', email: 'owner@example.com', name: 'Owner' });
    expect(u.role).toBe('Host');
  });

  it('leaves a verified non-allowlisted user as Host', () => {
    const u = upsertUserFromFirebase({ uid: 'uid_other', email: 'someone@example.com', name: 'Someone', email_verified: true });
    expect(u.role).toBe('Host');
    expect(u.is_admin).toBe(0);
  });

  it('self-heals: promotes an existing Host row for an allowlisted owner on next verified sign-in', () => {
    process.env.ADMIN_EMAILS = ''; // signed in before the operator configured the allowlist
    const first = upsertUserFromFirebase({ uid: 'uid_owner', email: 'owner@example.com', name: 'Owner', email_verified: true });
    expect(first.role).toBe('Host');
    process.env.ADMIN_EMAILS = 'owner@example.com'; // operator adds env var; owner signs in again
    const again = upsertUserFromFirebase({ uid: 'uid_owner', email: 'owner@example.com', name: 'Owner', email_verified: true });
    expect(again.id).toBe(first.id);
    expect(again.role).toBe('Admin');
    expect(listUsers()).toHaveLength(1);
  });

  it('never demotes a non-allowlisted Admin (additive only)', () => {
    const admin = upsertUserFromFirebase({ uid: 'uid_manual', email: 'manual@example.com', name: 'Manual', email_verified: true });
    setUserRole(admin.id, 'Admin'); // promoted out-of-band, e.g. via the admin panel
    const again = upsertUserFromFirebase({ uid: 'uid_manual', email: 'manual@example.com', name: 'Manual', email_verified: true });
    expect(again.role).toBe('Admin');
  });

  it('composes with adoption: a verified allowlisted login reclaims a same-email row and gets Admin', () => {
    // A pre-existing Host row owns the email under a different UID (unverified path).
    const host = upsertUserFromFirebase({ uid: 'uid_old', email: 'owner@example.com', name: 'Owner', email_verified: false });
    expect(host.role).toBe('Host');
    // Owner signs in with verified Google (new UID): adopt re-binds the row, allowlist grants Admin.
    const google = upsertUserFromFirebase({ uid: 'uid_google', email: 'owner@example.com', name: 'Owner', email_verified: true });
    expect(google.id).toBe(host.id);             // adopted, not duplicated
    expect(google.firebase_uid).toBe('uid_google');
    expect(google.role).toBe('Admin');
    expect(listUsers()).toHaveLength(1);
  });
});
