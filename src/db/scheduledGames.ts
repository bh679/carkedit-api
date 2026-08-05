// CarkedIt API — Scheduled lobbies.
//
// A Colyseus room only exists while at least one socket is connected, so a game
// arranged for next Friday has nowhere to live. A scheduled_games row IS the
// durable lobby: it reserves a join code, records the start time, and survives
// every room the code spins up and disposes in between.
//
// Lifecycle of a reservation:
//   created  → scheduled_at in the future, released_at NULL, code held
//   live     → a room is up (room_id set); rooms come and go freely pre-start
//   started  → the room left the 'lobby' phase (started_at set)
//   ended    → a started game's room disposed → ended_at + released_at
//   expired  → now > expires_at (scheduled_at + 24h) → released_at
//   cancelled→ host cancelled → cancelled_at + released_at
// Releasing is what returns the code to the word pool; the partial unique index
// idx_sched_code_active only constrains rows with released_at IS NULL.
import { randomUUID } from 'node:crypto';
import { getDb } from './database.js';
import { ROOM_CODE_WORDS } from '../rooms/roomWords.js';
import type { ScheduledGame, ScheduledGameStatus } from './types.js';

/** A scheduled game's link stays valid this long past its start time. */
export const SCHEDULE_TTL_HOURS = 24;
/** Guard rails on how far ahead a game may be scheduled. */
export const MIN_LEAD_MINUTES = 5;
export const MAX_LEAD_DAYS = 90;
/** Attempts to draw an unused code before giving up. */
const CODE_DRAW_ATTEMPTS = 25;

export class ScheduleValidationError extends Error {}
export class CodePoolExhaustedError extends Error {}

export function expiresAtFor(scheduledAtIso: string): string {
  return new Date(new Date(scheduledAtIso).getTime() + SCHEDULE_TTL_HOURS * 3600_000).toISOString();
}

/**
 * Normalise and bounds-check a client-supplied start time. Returns the ISO UTC
 * string to store. Throws ScheduleValidationError with a player-facing message.
 */
export function validateScheduledAt(input: unknown, now: Date = new Date()): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ScheduleValidationError('A start time is required');
  }
  const at = new Date(input);
  if (Number.isNaN(at.getTime())) {
    throw new ScheduleValidationError('That start time is not a valid date');
  }
  const leadMs = at.getTime() - now.getTime();
  if (leadMs < MIN_LEAD_MINUTES * 60_000) {
    throw new ScheduleValidationError(`Pick a time at least ${MIN_LEAD_MINUTES} minutes from now`);
  }
  if (leadMs > MAX_LEAD_DAYS * 86_400_000) {
    throw new ScheduleValidationError(`Games can only be scheduled up to ${MAX_LEAD_DAYS} days ahead`);
  }
  return at.toISOString();
}

/** True when an unreleased reservation currently holds this code. */
export function isCodeReserved(code: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM scheduled_games WHERE room_code = ? AND released_at IS NULL')
    .get(code.toUpperCase());
  return row !== undefined;
}

/**
 * Draw a join code no active reservation holds. `isCodeLive` lets the caller
 * also exclude codes held by currently-running Colyseus rooms (walk-up games
 * pick codes at random and are not recorded in scheduled_games).
 */
export async function reserveRoomCode(
  isCodeLive: (code: string) => Promise<boolean> = async () => false,
): Promise<string> {
  for (let i = 0; i < CODE_DRAW_ATTEMPTS; i++) {
    const code = ROOM_CODE_WORDS[Math.floor(Math.random() * ROOM_CODE_WORDS.length)];
    if (isCodeReserved(code)) continue;
    if (await isCodeLive(code)) continue;
    return code;
  }
  throw new CodePoolExhaustedError('No join codes are free right now — please try again shortly');
}

export function createScheduledGame(data: {
  room_code: string;
  scheduled_at: string;
  host_user_id: string;
  title?: string | null;
  brand_id?: string | null;
  is_dev?: boolean;
}): ScheduledGame {
  const db = getDb();
  const id = `sched_${randomUUID()}`;
  db.prepare(`
    INSERT INTO scheduled_games (id, room_code, scheduled_at, expires_at, created_at, host_user_id, title, brand_id, is_dev)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.room_code.toUpperCase(), data.scheduled_at, expiresAtFor(data.scheduled_at),
    new Date().toISOString(), data.host_user_id,
    data.title ?? null, data.brand_id ?? null, data.is_dev ? 1 : 0,
  );
  return getScheduledById(id)!;
}

export function getScheduledById(id: string): ScheduledGame | null {
  return (getDb().prepare('SELECT * FROM scheduled_games WHERE id = ?').get(id) as ScheduledGame | undefined) ?? null;
}

/**
 * The reservation a join link should resolve to. Prefers the active holder of
 * the code; failing that, falls back to a released row still inside its 24h
 * window so a link followed shortly after the game can say "already played"
 * rather than "no such code". Released rows can never be joined — isJoinable()
 * gates that — and the fallback expires with the window, so a recycled code
 * always belongs to its new owner.
 */
export function getScheduledByCode(code: string, now: Date = new Date()): ScheduledGame | null {
  const row = getDb()
    .prepare(`
      SELECT * FROM scheduled_games
      WHERE room_code = ? AND (released_at IS NULL OR expires_at > ?)
      ORDER BY (released_at IS NULL) DESC, created_at DESC
      LIMIT 1
    `)
    .get(code.toUpperCase(), now.toISOString()) as ScheduledGame | undefined;
  return row ?? null;
}

/**
 * Derive the state a caller sees. Expiry is computed rather than trusted to the
 * sweeper having run, so a link never appears joinable past its TTL.
 */
export function scheduledStatus(row: ScheduledGame, now: Date = new Date()): ScheduledGameStatus {
  if (row.cancelled_at) return 'cancelled';
  if (row.ended_at) return 'ended';
  if (new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  if (row.room_id) return 'live';
  return 'scheduled';
}

/** True when a room may be spun up for this reservation. */
export function isJoinable(row: ScheduledGame, now: Date = new Date()): boolean {
  const status = scheduledStatus(row, now);
  return status === 'scheduled' || status === 'live';
}

export function listScheduledForHost(hostUserId: string): ScheduledGame[] {
  return getDb()
    .prepare(`
      SELECT * FROM scheduled_games
      WHERE host_user_id = ? AND cancelled_at IS NULL AND expires_at > ?
      ORDER BY scheduled_at ASC
    `)
    .all(hostUserId, new Date().toISOString()) as ScheduledGame[];
}

/** Reschedule / rename. Recomputes expires_at so the TTL tracks the new time. */
export function updateScheduledGame(
  id: string,
  fields: { scheduled_at?: string; title?: string | null },
): ScheduledGame | null {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.scheduled_at !== undefined) {
    sets.push('scheduled_at = ?', 'expires_at = ?');
    params.push(fields.scheduled_at, expiresAtFor(fields.scheduled_at));
  }
  if (fields.title !== undefined) {
    sets.push('title = ?');
    params.push(fields.title);
  }
  if (sets.length === 0) return getScheduledById(id);
  params.push(id);
  const info = db.prepare(`UPDATE scheduled_games SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (info.changes === 0) return null;
  return getScheduledById(id);
}

/** Host cancellation — releases the code immediately. */
export function cancelScheduledGame(id: string): boolean {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare('UPDATE scheduled_games SET cancelled_at = ?, released_at = ? WHERE id = ? AND cancelled_at IS NULL')
    .run(now, now, id);
  return info.changes > 0;
}

/** Called when a room spins up for (or disposes from) a reservation. */
export function setScheduledRoom(id: string, roomId: string | null, gameId?: string | null): void {
  const db = getDb();
  if (gameId !== undefined) {
    db.prepare('UPDATE scheduled_games SET room_id = ?, game_id = ? WHERE id = ?').run(roomId, gameId, id);
  } else {
    db.prepare('UPDATE scheduled_games SET room_id = ? WHERE id = ?').run(roomId, id);
  }
}

/** First transition out of the lobby phase — the game is genuinely underway. */
export function markScheduledStarted(id: string): void {
  getDb()
    .prepare('UPDATE scheduled_games SET started_at = ? WHERE id = ? AND started_at IS NULL')
    .run(new Date().toISOString(), id);
}

/**
 * A started game's room went away (finished or abandoned): the link dies with
 * it, per the product rule that a code stops working once the game has run.
 */
export function markScheduledEnded(id: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare('UPDATE scheduled_games SET room_id = NULL, ended_at = COALESCE(ended_at, ?), released_at = COALESCE(released_at, ?) WHERE id = ?')
    .run(now, now, id);
}

/** Sweeper: return codes whose 24h window has passed to the pool. */
export function releaseExpired(now: Date = new Date()): number {
  const iso = now.toISOString();
  return getDb()
    .prepare('UPDATE scheduled_games SET released_at = ? WHERE released_at IS NULL AND expires_at <= ?')
    .run(iso, iso).changes;
}
