import type { Request, Response, NextFunction } from 'express';
import { upsertUserFromFirebase } from '../db/users.js';
import { getBrandById } from '../db/brands.js';
import type { User, Brand } from '../db/types.js';
import { hasRole, type Role } from '../auth/roles.js';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      firebaseUser?: { uid: string; email?: string; name?: string; picture?: string; email_verified?: boolean };
      localUser?: User;
    }
  }
}

let firebaseAuthAvailable = false;

export function setFirebaseAvailable(available: boolean): void {
  firebaseAuthAvailable = available;
}

export function isFirebaseAvailable(): boolean {
  return firebaseAuthAvailable;
}

/**
 * Partner-brand id carried in a signup request body, used ONLY to attribute a
 * brand-new account at creation time (upsertUserFromFirebase applies it on its
 * INSERT branch only; existing accounts are untouched). Returns undefined when
 * absent — `express.json()` runs before these middlewares, so `req.body` is
 * populated for JSON POSTs; multipart/GET requests simply yield undefined.
 */
function brandIdFromReq(req: Request): string | undefined {
  const b = (req.body as any)?.brand_id;
  return typeof b === 'string' && b ? b : undefined;
}

/**
 * Optional auth — attaches user if Bearer token present, does NOT reject without token.
 */
export function optionalAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!firebaseAuthAvailable) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return next();

    try {
      const { getAuth } = await import('firebase-admin/auth');
      const token = authHeader.split('Bearer ')[1];
      const decoded = await getAuth().verifyIdToken(token);
      req.firebaseUser = {
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
        email_verified: decoded.email_verified,
      };
      req.localUser = upsertUserFromFirebase(req.firebaseUser, brandIdFromReq(req));
    } catch (err: any) {
      console.warn('[CarkedIt Auth] Invalid token:', err.message);
    }
    next();
  };
}

/**
 * Required auth — returns 401 if no valid token.
 */
export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!firebaseAuthAvailable) {
      return res.status(503).json({ error: 'Authentication service not configured' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const { getAuth } = await import('firebase-admin/auth');
      const token = authHeader.split('Bearer ')[1];
      const decoded = await getAuth().verifyIdToken(token);
      req.firebaseUser = {
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
        email_verified: decoded.email_verified,
      };
      req.localUser = upsertUserFromFirebase(req.firebaseUser, brandIdFromReq(req));
      next();
    } catch (err: any) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

/**
 * Role-gated auth — requires valid token AND `localUser.role` ≥ `min` in the
 * Player < Host < QA < Admin hierarchy.
 */
export function requireRole(min: Role) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!firebaseAuthAvailable) {
      return res.status(503).json({ error: 'Authentication service not configured' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const { getAuth } = await import('firebase-admin/auth');
      const token = authHeader.split('Bearer ')[1];
      const decoded = await getAuth().verifyIdToken(token);
      req.firebaseUser = {
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name,
        picture: decoded.picture,
        email_verified: decoded.email_verified,
      };
      req.localUser = upsertUserFromFirebase(req.firebaseUser, brandIdFromReq(req));
      if (!hasRole(req.localUser, min)) {
        return res.status(403).json({ error: `${min} access required` });
      }
      next();
    } catch (err: any) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

/** Admin-tier access. Equivalent to requireRole('Admin'). */
export function requireAdmin() {
  return requireRole('Admin');
}

/** QA-tier access (includes Admin). */
export function requireQA() {
  return requireRole('QA');
}

/** Host-tier access (includes QA + Admin). */
export function requireHost() {
  return requireRole('Host');
}

/**
 * Pure access decision for an owner-gated brand panel. A global admin (legacy
 * `is_admin` column OR the current `role`-based 'Admin' tier) may inspect any
 * brand; otherwise only the brand's `owner_user_id` passes. Returns 'not_found'
 * when the brand id resolves to nothing (so the caller can 404 instead of 403).
 * Kept pure (no req/res) so the allow/deny logic is unit-testable without Firebase.
 */
export function brandAccessDecision(
  user: User | undefined,
  brand: Brand | null,
): 'ok' | 'not_found' | 'forbidden' {
  if (!brand) return 'not_found';
  if (!user) return 'forbidden';
  if (user.is_admin || hasRole(user, 'Admin') || brand.owner_user_id === user.id) return 'ok';
  return 'forbidden';
}

/**
 * Owner-gated brand access — wraps requireAuth() (which sends its own 503 when
 * Firebase is unavailable / 401 on a bad token and only invokes our callback on
 * success), then loads the brand via `:id` and applies brandAccessDecision.
 */
export function requireBrandOwner() {
  const auth = requireAuth();
  return (req: Request, res: Response, next: NextFunction) =>
    auth(req, res, () => {
      const decision = brandAccessDecision(req.localUser, getBrandById(String(req.params.id)));
      if (decision === 'not_found') return res.status(404).json({ error: 'Brand not found' });
      if (decision === 'forbidden') return res.status(403).json({ error: 'Brand owner access required' });
      next();
    });
}
