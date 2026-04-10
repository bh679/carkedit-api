import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';

/**
 * Strict limiter for unauthenticated POST routes that write to the database.
 * 30 requests per 15-minute window per IP.
 */
export const publicWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const PUBLIC_BODY_LIMIT = 256 * 1024; // 256kb

/**
 * Rejects requests with Content-Length exceeding 256kb.
 * Applied to unauthenticated POST routes to prevent abuse via oversized payloads,
 * since the global body parser allows up to 10mb for admin image-gen routes.
 */
export function publicBodyLimit(req: Request, res: Response, next: NextFunction) {
  const len = parseInt(req.headers['content-length'] || '0', 10);
  if (len > PUBLIC_BODY_LIMIT) {
    return res.status(413).json({ error: 'Payload too large' });
  }
  next();
}

/**
 * Lenient global limiter for all API routes.
 * 300 requests per 15-minute window per IP.
 */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
