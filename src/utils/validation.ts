/**
 * Pure input validators for request handlers. Each helper returns
 * a discriminated-union result so the caller can decide its own
 * response shape (status code, error envelope) without coupling
 * the validator to express.
 *
 * Used to prevent malformed bodies from reaching SQLite, where
 * NOT NULL / CHECK constraint violations were flooding pm2 logs
 * (see audit 2026-05-08).
 */

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Required string field. Rejects null/undefined/non-string/empty/whitespace-only.
 * Trims the accepted value.
 */
export function validateRequiredString(
  value: unknown,
  field: string,
): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} is required` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: `${field} is required` };
  }
  return { ok: true, value: trimmed };
}

/**
 * Optional string field, for UPDATE paths. `undefined` means
 * "don't change this field" and is accepted with `value: undefined`.
 * Anything else must be a non-empty string. Trims accepted values.
 */
export function validateOptionalString(
  value: unknown,
  field: string,
): ValidationResult<string | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: `${field} cannot be empty` };
  }
  return { ok: true, value: trimmed };
}

/**
 * Optional enum field, for UPDATE paths. `undefined` means "don't
 * change this field". Anything else must match one of `allowed`.
 */
export function validateEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): ValidationResult<T | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return {
      ok: false,
      error: `${field} must be one of: ${allowed.join(', ')}`,
    };
  }
  return { ok: true, value: value as T };
}

/**
 * Safe-coerce one untrusted player object into a row ready for the
 * `game_players` table. player_name and score are NOT NULL in the
 * schema, so this defaults missing/non-finite values rather than
 * letting them reach SQLite.
 */
export function coerceGamePlayer(
  p: { name?: unknown; score?: unknown },
  rank: number,
): { player_name: string; score: number; rank: number } {
  const player_name = typeof p?.name === 'string' && p.name.length > 0
    ? p.name
    : 'Unknown';
  const score = typeof p?.score === 'number' && Number.isFinite(p.score)
    ? p.score
    : 0;
  return { player_name, score, rank };
}

/**
 * Safe-coerce the top entry of a score-sorted player array into the
 * fields the `games` table requires (winner_name, winner_score, both
 * NOT NULL). Mirrors the precedent already in use in
 * GameRoom.persistGameResults so the live-completion and
 * client-submission paths agree on what "no winner" looks like.
 */
export function coerceWinner(
  sortedPlayers: { name?: unknown; score?: unknown }[],
): { winner_name: string; winner_score: number } {
  const { player_name, score } = coerceGamePlayer(sortedPlayers[0] ?? {}, 1);
  return { winner_name: player_name, winner_score: score };
}
