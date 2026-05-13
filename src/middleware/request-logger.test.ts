import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { attachRequestId, pickLevel, requestLogger, resolveThresholds } from './request-logger.js';

interface CapturedLine {
  level: number;
  msg?: string;
  req?: { id?: string; method?: string; url?: string };
  res?: { statusCode?: number; bytes?: number };
  uid?: string;
  roomCode?: string;
  slow?: boolean;
  responseTime?: number;
}

function makeCapture() {
  const lines: CapturedLine[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString('utf8');
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        try {
          lines.push(JSON.parse(raw));
        } catch {
          // Non-JSON lines (none expected) are ignored
        }
      }
      cb();
    },
  });
  return { lines, stream };
}

interface AppContext {
  baseUrl: string;
  lines: CapturedLine[];
  close: () => Promise<void>;
}

function buildApp(extraOpts: { warnMs?: number; errorMs?: number } = {}): Promise<AppContext> {
  const { lines, stream } = makeCapture();
  const app = express();
  app.use(attachRequestId);
  app.use((req, _res, next) => {
    const uid = req.headers['x-test-uid'];
    if (typeof uid === 'string' && uid) (req as any).firebaseUser = { uid };
    next();
  });
  app.use(requestLogger({
    warnMs: extraOpts.warnMs,
    errorMs: extraOpts.errorMs,
    level: 'trace',
    destination: stream as any,
  }));
  app.get('/healthy', (_req, res) => res.json({ ok: true }));
  app.get('/notfound', (_req, res) => res.status(404).json({ error: 'no' }));
  app.get('/boom', (_req, res) => res.status(500).json({ error: 'boom' }));
  app.get('/slow-warn', async (_req, res) => {
    await new Promise((r) => setTimeout(r, (extraOpts.warnMs ?? 500) + 80));
    res.json({ ok: true });
  });
  app.get('/slow-error', async (_req, res) => {
    await new Promise((r) => setTimeout(r, (extraOpts.errorMs ?? 2000) + 80));
    res.json({ ok: true });
  });
  app.get('/api/carkedit/rooms/lookup', (req, res) => res.json({ code: req.query.code }));

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        lines,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForLine(lines: CapturedLine[], match: (l: CapturedLine) => boolean, timeoutMs = 1500): Promise<CapturedLine> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = lines.find(match);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for log line'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('pickLevel', () => {
  it('returns error for 5xx', () => {
    expect(pickLevel(500, 10, undefined, 500, 2000)).toBe('error');
    expect(pickLevel(503, 10, undefined, 500, 2000)).toBe('error');
  });
  it('returns error when handler error attached', () => {
    expect(pickLevel(200, 10, new Error('x'), 500, 2000)).toBe('error');
  });
  it('returns error when elapsed exceeds errorMs', () => {
    expect(pickLevel(200, 2500, undefined, 500, 2000)).toBe('error');
  });
  it('returns warn when elapsed exceeds warnMs but not errorMs', () => {
    expect(pickLevel(200, 700, undefined, 500, 2000)).toBe('warn');
  });
  it('returns warn for 4xx with fast response', () => {
    expect(pickLevel(404, 5, undefined, 500, 2000)).toBe('warn');
  });
  it('returns info for happy path', () => {
    expect(pickLevel(200, 50, undefined, 500, 2000)).toBe('info');
  });
});

describe('resolveThresholds', () => {
  const originalWarn = process.env.LOG_SLOW_WARN_MS;
  const originalError = process.env.LOG_SLOW_ERROR_MS;
  afterEach(() => {
    if (originalWarn === undefined) delete process.env.LOG_SLOW_WARN_MS;
    else process.env.LOG_SLOW_WARN_MS = originalWarn;
    if (originalError === undefined) delete process.env.LOG_SLOW_ERROR_MS;
    else process.env.LOG_SLOW_ERROR_MS = originalError;
  });

  it('uses defaults when env unset', () => {
    delete process.env.LOG_SLOW_WARN_MS;
    delete process.env.LOG_SLOW_ERROR_MS;
    expect(resolveThresholds()).toEqual({ warnMs: 500, errorMs: 2000 });
  });
  it('honours env values', () => {
    process.env.LOG_SLOW_WARN_MS = '250';
    process.env.LOG_SLOW_ERROR_MS = '1500';
    expect(resolveThresholds()).toEqual({ warnMs: 250, errorMs: 1500 });
  });
  it('falls back when env is non-numeric', () => {
    process.env.LOG_SLOW_WARN_MS = 'abc';
    process.env.LOG_SLOW_ERROR_MS = '';
    expect(resolveThresholds()).toEqual({ warnMs: 500, errorMs: 2000 });
  });
  it('explicit opts override env', () => {
    process.env.LOG_SLOW_WARN_MS = '999';
    expect(resolveThresholds({ warnMs: 100 })).toEqual({ warnMs: 100, errorMs: 2000 });
  });
});

describe('attachRequestId', () => {
  let ctx: AppContext;
  beforeAll(async () => { ctx = await buildApp(); });
  afterAll(async () => { await ctx.close(); });

  it('generates a UUID when no inbound X-Request-Id', async () => {
    const res = await get(`${ctx.baseUrl}/healthy`);
    const id = res.headers['x-request-id'] as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('honours an inbound X-Request-Id', async () => {
    const res = await get(`${ctx.baseUrl}/healthy`, { 'x-request-id': 'inbound-correlation-12345' });
    expect(res.headers['x-request-id']).toBe('inbound-correlation-12345');
  });

  it('ignores whitespace-only X-Request-Id', async () => {
    const res = await get(`${ctx.baseUrl}/healthy`, { 'x-request-id': '   ' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('requestLogger output shape', () => {
  let ctx: AppContext;
  beforeAll(async () => { ctx = await buildApp(); });
  afterAll(async () => { await ctx.close(); });

  it('emits one JSON line per successful request with method, url, statusCode, level=info', async () => {
    await get(`${ctx.baseUrl}/healthy`);
    const line = await waitForLine(ctx.lines, (l) => l.req?.url === '/healthy');
    expect(line.level).toBe(30);
    expect(line.req?.method).toBe('GET');
    expect(line.res?.statusCode).toBe(200);
    expect(typeof line.req?.id).toBe('string');
  });

  it('escalates 4xx to warn', async () => {
    await get(`${ctx.baseUrl}/notfound`);
    const line = await waitForLine(ctx.lines, (l) => l.req?.url === '/notfound');
    expect(line.level).toBe(40);
    expect(line.res?.statusCode).toBe(404);
  });

  it('escalates 5xx to error', async () => {
    await get(`${ctx.baseUrl}/boom`);
    const line = await waitForLine(ctx.lines, (l) => l.req?.url === '/boom');
    expect(line.level).toBe(50);
    expect(line.res?.statusCode).toBe(500);
  });

  it('never emits the Authorization header value', async () => {
    await get(`${ctx.baseUrl}/healthy`, { authorization: 'Bearer should-not-appear' });
    await waitForLine(ctx.lines, (l) => l.req?.url === '/healthy');
    for (const l of ctx.lines) {
      expect(JSON.stringify(l)).not.toContain('should-not-appear');
    }
  });

  it('attaches firebaseUser.uid when present', async () => {
    await get(`${ctx.baseUrl}/healthy`, { 'x-test-uid': 'firebase-uid-42' });
    const line = await waitForLine(ctx.lines, (l) => l.uid === 'firebase-uid-42');
    expect(line.uid).toBe('firebase-uid-42');
  });

  it('attaches roomCode for /api/carkedit/rooms/lookup', async () => {
    await get(`${ctx.baseUrl}/api/carkedit/rooms/lookup?code=abcde`);
    const line = await waitForLine(ctx.lines, (l) => l.roomCode === 'ABCDE');
    expect(line.roomCode).toBe('ABCDE');
  });

  it('does not attach roomCode for unrelated paths', async () => {
    await get(`${ctx.baseUrl}/healthy?code=hello`);
    const line = await waitForLine(ctx.lines, (l) => l.req?.url === '/healthy?code=hello');
    expect(line.roomCode).toBeUndefined();
  });
});

describe('slow-handler level escalation (live)', () => {
  let ctx: AppContext;
  beforeAll(async () => { ctx = await buildApp({ warnMs: 200, errorMs: 600 }); });
  afterAll(async () => { await ctx.close(); });

  it('marks a slow request between warnMs and errorMs as warn with slow=true', async () => {
    await get(`${ctx.baseUrl}/slow-warn`);
    const line = await waitForLine(ctx.lines, (l) => l.req?.url === '/slow-warn', 5000);
    expect(line.level).toBe(40);
    expect(line.slow).toBe(true);
  }, 10000);

  it('marks a request over errorMs as error with slow=true', async () => {
    await get(`${ctx.baseUrl}/slow-error`);
    const line = await waitForLine(ctx.lines, (l) => l.req?.url === '/slow-error', 5000);
    expect(line.level).toBe(50);
    expect(line.slow).toBe(true);
  }, 10000);
});
