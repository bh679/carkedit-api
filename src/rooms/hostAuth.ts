import { isFirebaseAvailable } from '../middleware/auth.js';
import { upsertUserFromFirebase } from '../db/users.js';
import { hasRole } from '../auth/roles.js';
import type { User } from '../db/types.js';

export interface DecodedHostToken {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
}

export type HostTokenVerifier = (token: string) => Promise<DecodedHostToken>;

async function verifyWithFirebase(token: string): Promise<DecodedHostToken> {
  const { getAuth } = await import('firebase-admin/auth');
  const decoded = await getAuth().verifyIdToken(token);
  return {
    uid: decoded.uid,
    email: decoded.email,
    name: decoded.name,
    picture: decoded.picture,
    email_verified: decoded.email_verified,
  };
}

/**
 * Dev/test bypass for local environments and automated tests, which cannot
 * sign in to Firebase. Never set ALLOW_GUEST_HOSTING on prod or staging.
 */
export function isGuestHostingAllowed(): boolean {
  return process.env.ALLOW_GUEST_HOSTING === '1';
}

/**
 * Authorizes a room-create request: hosting requires a signed-up account —
 * a valid Firebase ID token resolving to a user with at least the 'Host'
 * role. Joining a room is intentionally not gated; this runs only from
 * GameRoom.onCreate.
 *
 * Returns the verified local user, or null when the dev bypass is active.
 * Throws Error with a player-facing message otherwise; Colyseus rejects the
 * client's create() call with that message.
 */
export async function verifyHostAuthorization(
  authToken: unknown,
  verifyToken: HostTokenVerifier = verifyWithFirebase,
): Promise<User | null> {
  if (isGuestHostingAllowed()) return null;

  if (!isFirebaseAvailable()) {
    throw new Error('Authentication service not configured');
  }
  if (typeof authToken !== 'string' || authToken.length === 0) {
    throw new Error('Please sign in to host a game');
  }

  let decoded: DecodedHostToken;
  try {
    decoded = await verifyToken(authToken);
  } catch {
    throw new Error('Invalid or expired session — please sign in again');
  }

  const user = upsertUserFromFirebase(decoded);
  if (!hasRole(user, 'Host')) {
    throw new Error('Hosting requires a Host account');
  }
  return user;
}
