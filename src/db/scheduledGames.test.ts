import { initDatabase, getDb } from './database.js';
import {
  reserveRoomCode,
  isCodeReserved,
  createScheduledGame,
  getScheduledByCode,
  getScheduledById,
  listScheduledForHost,
  updateScheduledGame,
  cancelScheduledGame,
  markScheduledStarted,
  markScheduledEnded,
  setScheduledRoom,
  scheduledStatus,
  isJoinable,
  releaseExpired,
  validateScheduledAt,
  expiresAtFor,
  ScheduleValidationError,
  CodePoolExhaustedError,
  MIN_LEAD_MINUTES,
  MAX_LEAD_DAYS,
} from './scheduledGames.js';

// Each test runs against a fresh in-memory DB carrying the full schema,
// including the partial unique index that enforces one active holder per code.
describe('scheduled games', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

  function schedule(overrides: Partial<Parameters<typeof createScheduledGame>[0]> = {}) {
    return createScheduledGame({
      room_code: 'GRAVE',
      scheduled_at: inHours(24),
      host_user_id: 'user_1',
      ...overrides,
    });
  }

  describe('validateScheduledAt', () => {
    it('accepts a time comfortably ahead and normalises it to ISO UTC', () => {
      const iso = validateScheduledAt(inHours(3));
      expect(new Date(iso).toISOString()).toBe(iso);
    });

    it('rejects missing, unparseable, too-soon and too-distant times', () => {
      expect(() => validateScheduledAt(undefined)).toThrow(ScheduleValidationError);
      expect(() => validateScheduledAt('not a date')).toThrow(ScheduleValidationError);
      // One minute inside the minimum lead time.
      const tooSoon = new Date(Date.now() + (MIN_LEAD_MINUTES - 1) * 60_000).toISOString();
      expect(() => validateScheduledAt(tooSoon)).toThrow(/at least/);
      const tooFar = new Date(Date.now() + (MAX_LEAD_DAYS + 1) * 86_400_000).toISOString();
      expect(() => validateScheduledAt(tooFar)).toThrow(/days ahead/);
    });
  });

  describe('reserveRoomCode', () => {
    it('never returns a code an active reservation already holds', async () => {
      schedule({ room_code: 'GRAVE' });
      // 200 draws is far more than enough to hit GRAVE by chance if unguarded.
      for (let i = 0; i < 200; i++) {
        expect(await reserveRoomCode()).not.toBe('GRAVE');
      }
    });

    it('skips codes a live walk-up room is using', async () => {
      const seen = new Set<string>();
      const code = await reserveRoomCode(async (c) => {
        seen.add(c);
        return c === 'GRAVE';
      });
      expect(code).not.toBe('GRAVE');
      expect(seen.size).toBeGreaterThan(0);
    });

    it('gives up cleanly rather than handing out a duplicate code', async () => {
      await expect(reserveRoomCode(async () => true)).rejects.toBeInstanceOf(CodePoolExhaustedError);
    });

    it('reissues a code once its reservation is released', async () => {
      const row = schedule({ room_code: 'GRAVE' });
      expect(isCodeReserved('GRAVE')).toBe(true);
      cancelScheduledGame(row.id);
      expect(isCodeReserved('GRAVE')).toBe(false);
    });

    it('refuses two active reservations on one code', () => {
      schedule({ room_code: 'GRAVE' });
      expect(() => schedule({ room_code: 'GRAVE' })).toThrow();
    });
  });

  describe('lifecycle', () => {
    it('stores the code uppercased and sets expiry 24h past the start', () => {
      const row = schedule({ room_code: 'grave', scheduled_at: inHours(5) });
      expect(row.room_code).toBe('GRAVE');
      expect(row.expires_at).toBe(expiresAtFor(row.scheduled_at));
      expect(new Date(row.expires_at).getTime() - new Date(row.scheduled_at).getTime()).toBe(24 * 3600_000);
    });

    it('reads as scheduled before a room exists and live once one does', () => {
      const row = schedule();
      expect(scheduledStatus(row)).toBe('scheduled');
      setScheduledRoom(row.id, 'room_abc', 'game_abc');
      const withRoom = getScheduledById(row.id)!;
      expect(scheduledStatus(withRoom)).toBe('live');
      expect(withRoom.game_id).toBe('game_abc');
      expect(isJoinable(withRoom)).toBe(true);
    });

    it('stays joinable when a pre-start room disposes', () => {
      const row = schedule();
      setScheduledRoom(row.id, 'room_abc', 'game_abc');
      setScheduledRoom(row.id, null);
      const after = getScheduledById(row.id)!;
      expect(scheduledStatus(after)).toBe('scheduled');
      expect(isJoinable(after)).toBe(true);
      expect(getScheduledByCode('GRAVE')?.id).toBe(row.id);
    });

    it('kills the link once a started game ends', () => {
      const row = schedule();
      markScheduledStarted(row.id);
      markScheduledEnded(row.id);
      const after = getScheduledById(row.id)!;
      expect(scheduledStatus(after)).toBe('ended');
      expect(isJoinable(after)).toBe(false);
      // Released, so the code returns to the pool and the link stops resolving.
      expect(getScheduledByCode('GRAVE')).toBeNull();
      expect(isCodeReserved('GRAVE')).toBe(false);
    });

    it('only records the first start', () => {
      const row = schedule();
      markScheduledStarted(row.id);
      const first = getScheduledById(row.id)!.started_at;
      markScheduledStarted(row.id);
      expect(getScheduledById(row.id)!.started_at).toBe(first);
    });

    it('reports a past-window reservation as expired even before the sweeper runs', () => {
      const row = schedule();
      getDb()
        .prepare('UPDATE scheduled_games SET scheduled_at = ?, expires_at = ? WHERE id = ?')
        .run(inHours(-48), inHours(-24), row.id);
      const stale = getScheduledById(row.id)!;
      expect(scheduledStatus(stale)).toBe('expired');
      expect(isJoinable(stale)).toBe(false);
    });

    it('sweeps expired reservations and leaves live ones alone', () => {
      const stale = schedule({ room_code: 'GRAVE' });
      const upcoming = schedule({ room_code: 'BONES' });
      getDb().prepare('UPDATE scheduled_games SET expires_at = ? WHERE id = ?').run(inHours(-1), stale.id);
      expect(releaseExpired()).toBe(1);
      expect(getScheduledById(stale.id)!.released_at).not.toBeNull();
      expect(getScheduledById(upcoming.id)!.released_at).toBeNull();
      // Sweeping twice must not re-release the same row.
      expect(releaseExpired()).toBe(0);
    });
  });

  describe('host management', () => {
    it('lists only the host own upcoming, uncancelled games', () => {
      const mine = schedule({ room_code: 'GRAVE', host_user_id: 'user_1' });
      const cancelled = schedule({ room_code: 'BONES', host_user_id: 'user_1' });
      schedule({ room_code: 'CRYPT', host_user_id: 'user_2' });
      cancelScheduledGame(cancelled.id);

      const list = listScheduledForHost('user_1');
      expect(list.map((r) => r.id)).toEqual([mine.id]);
    });

    it('recomputes expiry when rescheduled', () => {
      const row = schedule({ scheduled_at: inHours(2) });
      const moved = updateScheduledGame(row.id, { scheduled_at: inHours(50) })!;
      expect(moved.expires_at).toBe(expiresAtFor(moved.scheduled_at));
      expect(new Date(moved.expires_at).getTime()).toBeGreaterThan(new Date(row.expires_at).getTime());
    });

    it('cancels once and reports a cancelled status', () => {
      const row = schedule();
      expect(cancelScheduledGame(row.id)).toBe(true);
      expect(cancelScheduledGame(row.id)).toBe(false);
      expect(scheduledStatus(getScheduledById(row.id)!)).toBe('cancelled');
    });
  });
});
