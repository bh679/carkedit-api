import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import pinoHttp, { startTime } from 'pino-http';
import type { DestinationStream } from 'pino';

const DEFAULT_WARN_MS = 500;
const DEFAULT_ERROR_MS = 2000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface RequestLoggerOptions {
  warnMs?: number;
  errorMs?: number;
  level?: string;
  destination?: DestinationStream;
}

export function resolveThresholds(opts: RequestLoggerOptions = {}): { warnMs: number; errorMs: number } {
  return {
    warnMs: opts.warnMs ?? parsePositiveInt(process.env.LOG_SLOW_WARN_MS, DEFAULT_WARN_MS),
    errorMs: opts.errorMs ?? parsePositiveInt(process.env.LOG_SLOW_ERROR_MS, DEFAULT_ERROR_MS),
  };
}

export function attachRequestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const headerValue = Array.isArray(incoming) ? incoming[0] : incoming;
  const trimmed = typeof headerValue === 'string' ? headerValue.trim() : '';
  const id = trimmed || randomUUID();
  (req as any).id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export function pickLevel(
  statusCode: number,
  elapsedMs: number,
  err: Error | undefined,
  warnMs: number,
  errorMs: number,
): 'info' | 'warn' | 'error' {
  if (err || statusCode >= 500) return 'error';
  if (elapsedMs >= errorMs) return 'error';
  if (elapsedMs >= warnMs) return 'warn';
  if (statusCode >= 400) return 'warn';
  return 'info';
}

function elapsedMs(res: any): number {
  const started = res[startTime];
  if (typeof started !== 'number') return 0;
  return Date.now() - started;
}

export function requestLogger(opts: RequestLoggerOptions = {}) {
  const { warnMs, errorMs } = resolveThresholds(opts);
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info';

  const pinoOptions = {
    level,
    genReqId: (req: any) => req.id ?? randomUUID(),
    customLogLevel: (_req: any, res: any, err: Error | undefined) =>
      pickLevel(res.statusCode, elapsedMs(res), err, warnMs, errorMs),
    customProps: (req: any, res: any) => {
      const props: Record<string, unknown> = {};
      const uid = (req as Request).firebaseUser?.uid;
      if (uid) props.uid = uid;
      if ((req as Request).path === '/api/carkedit/rooms/lookup') {
        const code = String((req as Request).query.code ?? '').toUpperCase().trim();
        if (code) props.roomCode = code;
      }
      const elapsed = elapsedMs(res);
      if (elapsed >= warnMs) props.slow = true;
      return props;
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["set-cookie"]',
        'req.headers["x-amz-security-token"]',
      ],
      remove: true,
    },
    serializers: {
      req: (req: any) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: any) => {
        const headers = res.headers ?? (res.getHeaders ? res.getHeaders() : {});
        const cl = headers['content-length'];
        return {
          statusCode: res.statusCode,
          bytes: typeof cl === 'string' ? parseInt(cl, 10) : cl,
        };
      },
    },
  };

  return opts.destination ? pinoHttp(pinoOptions as any, opts.destination) : pinoHttp(pinoOptions as any);
}
