/**
 * Response-boundary PII redaction for the stats surfaces.
 *
 * Player/host names are visible to Admins ONLY. Every other caller — QA,
 * brand owners (Host-tier, via requireBrandOwner), and plain Hosts reading
 * their own games — receives masked names.
 *
 * This runs at the response boundary rather than inside the aggregation
 * functions in db/database.ts because those are shared verbatim by the global
 * (/games, /users/stats) and brand-scoped (/brands/:id/...) route families:
 * masking once here covers both, and leaves the query layer's unit tests
 * asserting real data.
 *
 * Historically masking lived in the CLIENT (four copies of maskName() in
 * carkedit-online). That was cosmetic — the real names were on the wire and
 * any brand owner could read them with devtools or curl. These helpers are the
 * enforcement; the client now renders whatever it is handed.
 *
 * Every helper is pure and immutable: rows are copied, never mutated, so a
 * redacted response can never write back into a cached DB row.
 */

import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { hasRole } from '../auth/roles.js';
import type {
  GameSummary, GameDetail, GamePlayerResult, GameDetailCardPlay,
  UserGameStat, SurveyResponse, GameEventRow, IssueReport,
} from '../db/types.js';

/**
 * First character + one asterisk per remaining character ('*' when empty or a
 * single character). Byte-identical to the client's former maskName so masked
 * output is unchanged for non-Admin viewers.
 */
export function maskName(name: string | null | undefined): string {
  if (!name || name.length <= 1) return '*';
  return name[0] + '*'.repeat(name.length - 1);
}

/** Same as maskName but preserves null (a null host_name stays null, not '*'). */
function maskNullableName(name: string | null | undefined): string | null {
  return name === null || name === undefined ? null : maskName(name);
}

/**
 * True when the caller may see real names. Derived solely from the
 * server-verified `req.localUser` the auth middleware attached — never from a
 * query param, header, or anything else the client controls.
 */
export function canSeePii(req: Request): boolean {
  return hasRole(req.localUser, 'Admin');
}

/**
 * Opaque stand-in for UserGameStat.name_key. The real key is the lowercased
 * player name and is used by the client as the row identity (expand/collapse,
 * per-player game lookups), so passing it through would leak every name we
 * just masked. A truncated SHA-256 keeps it stable across requests — the
 * client's expand handler still round-trips — without being reversible.
 */
export function opaqueKey(nameKey: string): string {
  return createHash('sha256').update(nameKey).digest('hex').slice(0, 16);
}

/** An opaque key as produced by opaqueKey — 16 lowercase hex chars. */
export function isOpaqueKey(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value);
}

/**
 * Reverse an opaque key back to the real name key by hashing candidates.
 *
 * The Users table lets a viewer expand a row to list that player's games, and
 * the client sends the row's `name_key` back as `?playerName=`. Non-Admins hold
 * only the opaque form, so without this the expand would silently return zero
 * games. Hashing is one-way, so we re-hash the known name keys and match —
 * cheap enough for a stats view, and it never widens what the caller can see
 * (they still receive masked names in the games that come back).
 *
 * Returns null when nothing matches.
 */
export function resolveOpaqueKey(key: string, candidates: string[]): string | null {
  return candidates.find(c => opaqueKey(c) === key) ?? null;
}

function redactPlayers(players: GamePlayerResult[] | undefined): GamePlayerResult[] {
  return (players ?? []).map(p => ({ ...p, player_name: maskName(p.player_name) }));
}

function redactCardPlays(plays: GameDetailCardPlay[] | undefined): GameDetailCardPlay[] {
  return (plays ?? []).map(c => ({ ...c, player_name: maskName(c.player_name) }));
}

function redactGameSummaryRow(g: GameSummary): GameSummary {
  return {
    ...g,
    host_name: maskNullableName(g.host_name),
    winner_name: maskName(g.winner_name),
    players: redactPlayers(g.players),
  };
}

/** `{ games, total }` from getRecentGames. */
export function redactGameList<T extends { games: GameSummary[] }>(result: T, reveal: boolean): T {
  if (reveal) return result;
  return { ...result, games: result.games.map(redactGameSummaryRow) };
}

/** Single game from getGameById — summary fields plus card plays and issues. */
export function redactGameDetail(game: GameDetail, reveal: boolean): GameDetail {
  if (reveal) return game;
  return {
    ...redactGameSummaryRow(game),
    settings_json: game.settings_json,
    card_plays: redactCardPlays(game.card_plays),
    issues: redactIssueList(game.issues ?? [], reveal),
  };
}

/**
 * `{ players, total_distinct, total_matched_users }` from getUserGameStats.
 * Email is DROPPED rather than masked — a partial email is still an identifier,
 * and brand owners have no need for it. avatar_url is dropped for the same
 * reason: a Google profile photo identifies a person as surely as their name.
 */
export function redactUserStats<T extends { players: UserGameStat[] }>(result: T, reveal: boolean): T {
  if (reveal) return result;
  return {
    ...result,
    players: result.players.map(p => ({
      ...p,
      name_key: opaqueKey(p.name_key),
      display_name: maskName(p.display_name),
      email: null,
      avatar_url: null,
    })),
  };
}

/** `{ responses, total }` from getSurveyResponses. */
export function redactSurveyResponses<T extends { responses: SurveyResponse[] }>(result: T, reveal: boolean): T {
  if (reveal) return result;
  return {
    ...result,
    responses: result.responses.map(r => ({
      ...r,
      player_name: r.player_name ? maskName(r.player_name) : r.player_name,
    })),
  };
}

/** Raw event rows from getGameEvents. */
export function redactGameEvents(events: GameEventRow[], reveal: boolean): GameEventRow[] {
  if (reveal) return events;
  return events.map(e => ({
    ...e,
    actor_name: maskNullableName(e.actor_name),
    // data_json is a free-form event payload that can embed player names in
    // keys we don't control, so it is dropped wholesale rather than walked.
    data_json: null,
  }));
}

/**
 * Issue reports. players_json / game_state_json are raw debug blobs that embed
 * player names; they are dropped for non-Admins rather than parsed.
 */
export function redactIssueList(reports: IssueReport[], reveal: boolean): IssueReport[] {
  if (reveal) return reports;
  return reports.map(({ players_json, game_state_json, ...rest }) => rest);
}

/** `{ reports, total }` from getIssueReports. */
export function redactIssueReports<T extends { reports: IssueReport[] }>(result: T, reveal: boolean): T {
  if (reveal) return result;
  return { ...result, reports: redactIssueList(result.reports, reveal) };
}

/**
 * Brand-scoped accounts list from listBrandUsers ({ id, display_name, created_at }).
 * Brand owners see their own signups here; the names are still masked because
 * "Admin only" is the rule for every stats surface.
 */
export function redactBrandUsers<T extends { display_name: string | null }>(users: T[], reveal: boolean): T[] {
  if (reveal) return users;
  return users.map(u => ({ ...u, display_name: maskNullableName(u.display_name) }));
}
