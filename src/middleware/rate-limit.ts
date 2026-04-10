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
