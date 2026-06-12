import { initDatabase } from '../db/database.js';
import { setUserRole, listUsers } from '../db/users.js';
import { setFirebaseAvailable } from '../middleware/auth.js';
import { verifyHostAuthorization, type DecodedHostToken } from './hostAuth.js';

const verifierFor = (decoded: DecodedHostToken) => async () => decoded;
const failingVerifier = async (): Promise<DecodedHostToken> => {
  throw new Error('bad token');
};

// Each test runs against a fresh in-memory DB. Firebase Admin is never
// called — token verification is injected so the auth decision logic is
// tested in isolation.
describe('verifyHostAuthorization — signup required to host', () => {
  beforeEach(() => {
    initDatabase(':memory:');
    setFirebaseAvailable(true);
    delete process.env.ALLOW_GUEST_HOSTING;
  });

  afterAll(() => {
    delete process.env.ALLOW_GUEST_HOSTING;
    setFirebaseAvailable(false);
  });

  it('rejects hosting without a token', async () => {
    await expect(verifyHostAuthorization(undefined)).rejects.toThrow(
      'Please sign in to host a game',
    );
  });

  it('rejects empty and non-string tokens', async () => {
    await expect(verifyHostAuthorization('')).rejects.toThrow('Please sign in to host a game');
    await expect(verifyHostAuthorization(42)).rejects.toThrow('Please sign in to host a game');
  });

  it('rejects an invalid or expired token', async () => {
    await expect(verifyHostAuthorization('garbage', failingVerifier)).rejects.toThrow(
      'Invalid or expired session — please sign in again',
    );
  });

  it('accepts a signed-up user and returns their account', async () => {
    const user = await verifyHostAuthorization(
      'valid-token',
      verifierFor({ uid: 'uid_host', email: 'host@example.com', name: 'Hosty', email_verified: true }),
    );
    expect(user).not.toBeNull();
    expect(user!.firebase_uid).toBe('uid_host');
    expect(user!.role).toBe('Host');
    expect(listUsers()).toHaveLength(1);
  });

  it('rejects a user demoted below the Host role', async () => {
    const decoded: DecodedHostToken = { uid: 'uid_demoted', email: 'd@example.com', name: 'Demoted' };
    const user = await verifyHostAuthorization('valid-token', verifierFor(decoded));
    setUserRole(user!.id, 'Player');

    await expect(verifyHostAuthorization('valid-token', verifierFor(decoded))).rejects.toThrow(
      'Hosting requires a Host account',
    );
  });

  it('fails closed when Firebase Admin is not configured', async () => {
    setFirebaseAvailable(false);
    await expect(
      verifyHostAuthorization('valid-token', verifierFor({ uid: 'uid_x' })),
    ).rejects.toThrow('Authentication service not configured');
  });

  it('ALLOW_GUEST_HOSTING=1 bypasses the check and returns null (local dev only)', async () => {
    process.env.ALLOW_GUEST_HOSTING = '1';
    await expect(verifyHostAuthorization(undefined)).resolves.toBeNull();
    expect(listUsers()).toHaveLength(0);
  });

  it('does not bypass for other ALLOW_GUEST_HOSTING values', async () => {
    process.env.ALLOW_GUEST_HOSTING = 'true';
    await expect(verifyHostAuthorization(undefined)).rejects.toThrow(
      'Please sign in to host a game',
    );
  });
});
