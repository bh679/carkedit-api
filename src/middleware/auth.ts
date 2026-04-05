import type { Request, Response, NextFunction } from 'express';
import { upsertUserFromFirebase } from '../db/users.js';
import type { User } from '../db/types.js';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      firebaseUser?: { uid: string; email?: string; name?: string; picture?: string };
      localUser?: User;
    }
  }
}

let firebaseAuthAvailable = false;

export function setFirebaseAvailable(available: boolean): void {
  firebaseAuthAvailable = available;
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
      };
      req.localUser = upsertUserFromFirebase(req.firebaseUser);
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
      };
      req.localUser = upsertUserFromFirebase(req.firebaseUser);
      next();
    } catch (err: any) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
