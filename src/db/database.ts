import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { GameResult, GameSummary, GameDetail, GameDetailCardPlay, GamePlayerResult, CardPlay, CardDraw, CardStat, IssueReport, GameEvent, GameEventRow, SurveyResponse, SurveyStats, UserGameStat } from './types.js';
import { DIE_CARDS, LIVING_CARDS, BYE_CARDS } from '../data/cards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/games.db');

export const STATUS_GROUPS: Record<string, string[]> = {
  lobby:    ['lobby', ''],
  die:      ['die', 'die_phase'],
  living:   ['live', 'living_setup', 'living_submit', 'living_reveal', 'living_convince', 'living_select', 'living_winner'],
  bye:      ['bye', 'bye_setup', 'bye_submit', 'bye_reveal', 'bye_convince', 'bye_select', 'bye_winner'],
  eulogy:   ['eulogy', 'eulogy_intro', 'eulogy_pick', 'eulogy_speech', 'eulogy_judge', 'eulogy_points'],
  finished: ['finished', 'winner', 'game_over'],
  other:    ['abandoned'],
};

export const DURATION_BUCKETS: Record<string, { min: number | null; max: number | null }> = {
  under5:   { min: null, max: 299 },
  '5to15':  { min: 300, max: 899 },
  '15to30': { min: 900, max: 1799 },
  over30:   { min: 1800, max: null },
};

let db: Database.Database;

export function getDb(): Database.Database {
  return db;
}

export function initDatabase(dbPath: string = DB_PATH): void {
  // Tests pass ':memory:' for an isolated, disposable DB; production uses the
  // default on-disk path. Skip the mkdir for the in-memory sentinel.
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      started_at TEXT,
      finished_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      room_code TEXT,
      host_name TEXT,
      rounds INTEGER NOT NULL,
      player_count INTEGER NOT NULL,
      winner_name TEXT NOT NULL,
      winner_score INTEGER NOT NULL,
      duration_seconds INTEGER,
      status TEXT NOT NULL DEFAULT 'finished',
      live_status TEXT NOT NULL DEFAULT 'completed',
      has_error INTEGER NOT NULL DEFAULT 0,
      is_dev INTEGER NOT NULL DEFAULT 0,
      api_version TEXT,
      client_version TEXT,
      settings_json TEXT,
      host_ip_hash TEXT,
      host_user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS game_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL REFERENCES games(id),
      player_name TEXT NOT NULL,
      score INTEGER NOT NULL,
      rank INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_game_players_game_id ON game_players(game_id);
    CREATE INDEX IF NOT EXISTS idx_games_finished_at ON games(finished_at);

    CREATE TABLE IF NOT EXISTS card_plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL REFERENCES games(id),
      round INTEGER NOT NULL,
      phase TEXT NOT NULL,
      card_id TEXT NOT NULL,
      card_text TEXT NOT NULL,
      card_deck TEXT NOT NULL,
      player_name TEXT NOT NULL,
      is_winner INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_card_plays_card_id ON card_plays(card_id, card_deck);
    CREATE INDEX IF NOT EXISTS idx_card_plays_game_id ON card_plays(game_id);

    CREATE TABLE IF NOT EXISTS card_draws (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL REFERENCES games(id),
      phase TEXT NOT NULL,
      card_id TEXT NOT NULL,
      card_deck TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_card_draws_card_id ON card_draws(card_id, card_deck);
    CREATE INDEX IF NOT EXISTS idx_card_draws_game_id ON card_draws(game_id);

    CREATE TABLE IF NOT EXISTS issue_reports (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      game_id TEXT,
      room_code TEXT,
      game_mode TEXT,
      screen TEXT,
      phase TEXT,
      player_count INTEGER,
      players_json TEXT,
      game_state_json TEXT,
      device_info TEXT,
      error_log TEXT,
      client_version TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_issue_reports_created_at ON issue_reports(created_at);

    CREATE TABLE IF NOT EXISTS game_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT,
      room_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_session_id TEXT,
      actor_name TEXT,
      phase TEXT,
      round INTEGER,
      data_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_game_events_room_id ON game_events(room_id);
    CREATE INDEX IF NOT EXISTS idx_game_events_game_id ON game_events(game_id);
    CREATE INDEX IF NOT EXISTS idx_game_events_type ON game_events(event_type);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      firebase_uid TEXT UNIQUE,
      display_name TEXT NOT NULL,
      email TEXT,
      avatar_url TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      birth_month INTEGER NOT NULL DEFAULT 0,
      birth_day INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);

    CREATE TABLE IF NOT EXISTS expansion_packs (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
      is_official INTEGER NOT NULL DEFAULT 0,
      is_dev INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      featured_card_id TEXT REFERENCES expansion_cards(id) ON DELETE SET NULL,
      brand_image_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_packs_creator ON expansion_packs(creator_id);
    CREATE INDEX IF NOT EXISTS idx_packs_status ON expansion_packs(status);
    -- idx_packs_official is created in the migration block below, after the
    -- is_official column is guaranteed to exist on pre-existing DBs.

    CREATE TABLE IF NOT EXISTS pack_favorites (
      user_id TEXT NOT NULL REFERENCES users(id),
      pack_id TEXT NOT NULL REFERENCES expansion_packs(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, pack_id)
    );
    CREATE INDEX IF NOT EXISTS idx_favorites_user ON pack_favorites(user_id);

    CREATE TABLE IF NOT EXISTS pack_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_id TEXT NOT NULL REFERENCES expansion_packs(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL,
      used_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pack_usage_pack ON pack_usage(pack_id);
    CREATE INDEX IF NOT EXISTS idx_pack_usage_game ON pack_usage(game_id);

    CREATE TABLE IF NOT EXISTS expansion_cards (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL REFERENCES expansion_packs(id) ON DELETE CASCADE,
      deck_type TEXT NOT NULL CHECK(deck_type IN ('die', 'live', 'bye')),
      text TEXT NOT NULL,
      prompt TEXT,
      card_special TEXT,
      options_json TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cards_pack ON expansion_cards(pack_id);

    CREATE TABLE IF NOT EXISTS survey_responses (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      game_id TEXT,
      player_name TEXT,
      session_id TEXT,
      nps_score INTEGER NOT NULL CHECK(nps_score BETWEEN 0 AND 10),
      comment TEXT,
      improvement TEXT,
      client_version TEXT,
      is_dev INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_survey_created_at ON survey_responses(created_at);
    CREATE INDEX IF NOT EXISTS idx_survey_game_id ON survey_responses(game_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_game_session
      ON survey_responses(game_id, session_id) WHERE session_id IS NOT NULL;

    -- Test admin page: every click of Generate on /admin-image-gen.html
    -- writes a row here so the Recent generations gallery can replay
    -- the full card context + the locally-downloaded image URL. Kept
    -- separate from expansion_cards so the log can grow without
    -- polluting the real deck.
    CREATE TABLE IF NOT EXISTS generation_log (
      id TEXT PRIMARY KEY,
      creator_id TEXT,
      deck_type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      prompt TEXT,
      card_special TEXT,
      options_json TEXT,
      image_url TEXT NOT NULL,
      image_url_b TEXT,
      provider TEXT NOT NULL,
      prompt_sent TEXT NOT NULL,
      tokens_used INTEGER,
      cost_usd REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gen_log_created ON generation_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gen_log_creator ON generation_log(creator_id);

    -- Unified cost storage for all sources: remote environment reports
    -- (dev/staging → play), AWS/Cloudflare API data, manual entries, etc.
    CREATE TABLE IF NOT EXISTS cost_entries (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'prod',
      source TEXT NOT NULL DEFAULT 'manual',
      source_ref TEXT UNIQUE,
      entered_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cost_entries_service ON cost_entries(service);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_period ON cost_entries(period_start, period_end);

    CREATE TABLE IF NOT EXISTS mailing_list (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      player_name TEXT,
      source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mailing_email ON mailing_list(email);

    CREATE TABLE IF NOT EXISTS page_permissions (
      path TEXT PRIMARY KEY,
      min_role TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by_user_id TEXT
    );
  `);

  // Migrate: add new columns if they don't exist (for existing DBs)
  const cols = db.prepare("PRAGMA table_info(games)").all().map((c: any) => c.name);
  const migrations: [string, string][] = [
    ['started_at', 'ALTER TABLE games ADD COLUMN started_at TEXT'],
    ['host_name', 'ALTER TABLE games ADD COLUMN host_name TEXT'],
    ['status', "ALTER TABLE games ADD COLUMN status TEXT NOT NULL DEFAULT 'finished'"],
    ['live_status', "ALTER TABLE games ADD COLUMN live_status TEXT NOT NULL DEFAULT 'completed'"],
    ['has_error', 'ALTER TABLE games ADD COLUMN has_error INTEGER NOT NULL DEFAULT 0'],
    ['is_dev', 'ALTER TABLE games ADD COLUMN is_dev INTEGER NOT NULL DEFAULT 0'],
    ['api_version', 'ALTER TABLE games ADD COLUMN api_version TEXT'],
    ['client_version', 'ALTER TABLE games ADD COLUMN client_version TEXT'],
    ['host_ip_hash', 'ALTER TABLE games ADD COLUMN host_ip_hash TEXT'],
    ['host_user_id', 'ALTER TABLE games ADD COLUMN host_user_id TEXT'],
  ];
  for (const [col, sql] of migrations) {
    if (!cols.includes(col)) {
      db.exec(sql);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_games_host_user_id ON games(host_user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_games_host_ip_hash ON games(host_ip_hash)');

  // Migrate: add missing columns to users if needed (for existing DBs)
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c: any) => c.name);
  if (!userCols.includes('is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.includes('birth_month')) {
    db.exec('ALTER TABLE users ADD COLUMN birth_month INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.includes('birth_day')) {
    db.exec('ALTER TABLE users ADD COLUMN birth_day INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.includes('role')) {
    // RBAC migration: add role column, then one-shot backfill from is_admin.
    // Existing admins → 'Admin'; everyone else → 'Host' (preserves today's
    // behaviour where any signed-up user can create packs and host games).
    // `is_admin` is intentionally retained for one release cycle so a rollback
    // to the prior API still recognises admins. Drop in a follow-up patch.
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'Host'");
    db.exec("UPDATE users SET role = 'Admin' WHERE is_admin = 1");
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
  }

  // Migrate: add is_dev column to survey_responses (for existing DBs)
  const surveyCols = db.prepare("PRAGMA table_info(survey_responses)").all().map((c: any) => c.name);
  if (surveyCols.length > 0 && !surveyCols.includes('is_dev')) {
    db.exec('ALTER TABLE survey_responses ADD COLUMN is_dev INTEGER NOT NULL DEFAULT 0');
  }

  // Migrate: add is_official column to expansion_packs (for existing DBs)
  const packCols = db.prepare("PRAGMA table_info(expansion_packs)").all().map((c: any) => c.name);
  if (!packCols.includes('is_official')) {
    db.exec('ALTER TABLE expansion_packs ADD COLUMN is_official INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_packs_official ON expansion_packs(is_official)');
  }
  if (!packCols.includes('is_dev')) {
    db.exec('ALTER TABLE expansion_packs ADD COLUMN is_dev INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_packs_dev ON expansion_packs(is_dev)');
  }
  // Migrate: add prompt column to expansion_cards (for existing DBs)
  const cardCols = db.prepare("PRAGMA table_info(expansion_cards)").all().map((c: any) => c.name);
  if (!cardCols.includes('prompt')) {
    db.exec('ALTER TABLE expansion_cards ADD COLUMN prompt TEXT');
  }
  if (!cardCols.includes('card_special')) {
    db.exec('ALTER TABLE expansion_cards ADD COLUMN card_special TEXT');
  }
  if (!cardCols.includes('options_json')) {
    db.exec('ALTER TABLE expansion_cards ADD COLUMN options_json TEXT');
  }
  if (!cardCols.includes('image_url')) {
    db.exec('ALTER TABLE expansion_cards ADD COLUMN image_url TEXT');
  }
  if (!cardCols.includes('text_position')) {
    db.exec("ALTER TABLE expansion_cards ADD COLUMN text_position TEXT DEFAULT 'top'");
  }
  if (!cardCols.includes('text_color')) {
    db.exec("ALTER TABLE expansion_cards ADD COLUMN text_color TEXT DEFAULT 'black'");
  }

  if (!packCols.includes('featured_card_id')) {
    // No FK on ALTER (SQLite limitation); deletion cleanup is enforced in deleteCard().
    db.exec('ALTER TABLE expansion_packs ADD COLUMN featured_card_id TEXT');
  }
  if (!packCols.includes('brand_image_url')) {
    db.exec('ALTER TABLE expansion_packs ADD COLUMN brand_image_url TEXT');
  }
  if (!packCols.includes('base_cost_usd')) {
    db.exec('ALTER TABLE expansion_packs ADD COLUMN base_cost_usd REAL NOT NULL DEFAULT 0');
  }

  // Migrate: drop legacy `visibility` column from expansion_packs.
  // The column was never written by any code path (every pack was stuck at
  // 'private'), so the marketplace browse query — which required
  // visibility='public' — never returned user packs. Removing the column
  // collapses publish-vs-listed into a single `status` field.
  //
  // Hard-fail on startup if the migration cannot run, to make a misconfigured
  // production SQLite impossible to miss (silent fallback would silently
  // re-create the original "marketplace empty" bug).
  if (packCols.includes('visibility')) {
    const sqliteVersion = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    const [maj, min] = sqliteVersion.split('.').map((n) => parseInt(n, 10));
    if (maj < 3 || (maj === 3 && min < 35)) {
      throw new Error(
        `[CarkedIt API] FATAL: SQLite ${sqliteVersion} too old to drop ` +
        `expansion_packs.visibility column (need 3.35+). Upgrade better-sqlite3 ` +
        `or run the migration manually.`
      );
    }
    try {
      db.exec('DROP INDEX IF EXISTS idx_packs_visibility_status');
      db.exec('ALTER TABLE expansion_packs DROP COLUMN visibility');
    } catch (err: any) {
      throw new Error(
        `[CarkedIt API] FATAL: pack-visibility migration failed: ${err?.message || err}`
      );
    }
    const after = db.prepare("PRAGMA table_info(expansion_packs)").all().map((c: any) => c.name);
    if (after.includes('visibility')) {
      throw new Error(
        '[CarkedIt API] FATAL: pack-visibility migration appeared to succeed ' +
        'but column still present'
      );
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_packs_status ON expansion_packs(status)');
    console.log('[CarkedIt API] Migration: dropped expansion_packs.visibility column');
  }

  // Migrate: add cost-tracking columns to generation_log (for existing DBs)
  const genLogCols = db.prepare("PRAGMA table_info(generation_log)").all().map((c: any) => c.name);
  if (!genLogCols.includes('tokens_used')) {
    db.exec('ALTER TABLE generation_log ADD COLUMN tokens_used INTEGER');
  }
  if (!genLogCols.includes('cost_usd')) {
    db.exec('ALTER TABLE generation_log ADD COLUMN cost_usd REAL');
  }
  if (!genLogCols.includes('pack_id')) {
    db.exec('ALTER TABLE generation_log ADD COLUMN pack_id TEXT');
  }
  if (!genLogCols.includes('card_id')) {
    db.exec('ALTER TABLE generation_log ADD COLUMN card_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_gen_log_pack ON generation_log(pack_id)');
}

export function saveGameResult(result: GameResult): string {
  const insertGame = db.prepare(`
    INSERT INTO games (id, started_at, finished_at, mode, room_code, host_name, rounds, player_count,
      winner_name, winner_score, duration_seconds, status, live_status, has_error, is_dev,
      api_version, client_version, settings_json, host_ip_hash, host_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPlayer = db.prepare(`
    INSERT INTO game_players (game_id, player_name, score, rank)
    VALUES (?, ?, ?, ?)
  `);

  const transaction = db.transaction((r: GameResult) => {
    insertGame.run(
      r.id, r.started_at ?? null, r.finished_at, r.mode, r.room_code ?? null,
      r.host_name ?? null, r.rounds, r.player_count, r.winner_name, r.winner_score,
      r.duration_seconds ?? null, r.status, r.live_status,
      r.has_error ? 1 : 0, r.is_dev ? 1 : 0,
      r.api_version ?? null, r.client_version ?? null, r.settings_json ?? null,
      r.host_ip_hash ?? null, r.host_user_id ?? null
    );
    for (const p of r.players) {
      insertPlayer.run(r.id, p.player_name, p.score, p.rank);
    }
    return r.id;
  });

  return transaction(result);
}

export interface LiveGameData {
  id: string;
  started_at: string;
  mode: 'online' | 'local';
  room_code?: string;
  host_name?: string;
  player_count: number;
  is_dev: boolean;
  api_version?: string;
  host_ip_hash?: string;
  host_user_id?: string;
}

export function createLiveGame(data: LiveGameData): string {
  db.prepare(`
    INSERT INTO games (id, started_at, finished_at, mode, room_code, host_name, rounds, player_count,
      winner_name, winner_score, duration_seconds, status, live_status, has_error, is_dev,
      api_version, client_version, settings_json, host_ip_hash, host_user_id)
    VALUES (?, ?, '', ?, ?, ?, 0, ?, '', 0, NULL, 'lobby', 'live', 0, ?, ?, NULL, NULL, ?, ?)
  `).run(
    data.id, data.started_at, data.mode, data.room_code ?? null,
    data.host_name ?? null, data.player_count,
    data.is_dev ? 1 : 0, data.api_version ?? null,
    data.host_ip_hash ?? null, data.host_user_id ?? null
  );
  return data.id;
}

export function updateLiveGame(id: string, updates: { playerCount?: number; status?: string; hostName?: string; hostIpHash?: string; hostUserId?: string }): void {
  const sets: string[] = [];
  const params: any[] = [];
  if (updates.playerCount !== undefined) { sets.push('player_count = ?'); params.push(updates.playerCount); }
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.hostName !== undefined) { sets.push('host_name = ?'); params.push(updates.hostName); }
  if (updates.hostIpHash !== undefined) { sets.push('host_ip_hash = COALESCE(host_ip_hash, ?)'); params.push(updates.hostIpHash); }
  if (updates.hostUserId !== undefined) { sets.push('host_user_id = COALESCE(host_user_id, ?)'); params.push(updates.hostUserId); }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ? AND live_status = 'live'`).run(...params);
}

export interface CompleteLiveGameData {
  finished_at: string;
  rounds: number;
  player_count: number;
  winner_name: string;
  winner_score: number;
  duration_seconds?: number;
  has_error: boolean;
  is_dev: boolean;
  settings_json?: string;
  host_ip_hash?: string;
  host_user_id?: string;
  players: { player_name: string; score: number; rank: number }[];
}

export function completeLiveGame(id: string, data: CompleteLiveGameData): void {
  const updateGame = db.prepare(`
    UPDATE games SET finished_at = ?, rounds = ?, player_count = ?,
      winner_name = ?, winner_score = ?, duration_seconds = ?,
      status = 'finished', live_status = 'completed',
      has_error = ?, is_dev = ?, settings_json = ?,
      host_ip_hash = COALESCE(?, host_ip_hash),
      host_user_id = COALESCE(?, host_user_id)
    WHERE id = ?
  `);

  const insertPlayer = db.prepare(`
    INSERT INTO game_players (game_id, player_name, score, rank)
    VALUES (?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    updateGame.run(
      data.finished_at, data.rounds, data.player_count,
      data.winner_name, data.winner_score, data.duration_seconds ?? null,
      data.has_error ? 1 : 0, data.is_dev ? 1 : 0, data.settings_json ?? null,
      data.host_ip_hash ?? null, data.host_user_id ?? null,
      id
    );
    for (const p of data.players) {
      insertPlayer.run(id, p.player_name, p.score, p.rank);
    }
  });

  transaction();
}

export function abandonGame(id: string, durationSeconds?: number): void {
  db.prepare(`
    UPDATE games SET live_status = 'abandoned', finished_at = ?, duration_seconds = COALESCE(?, duration_seconds)
    WHERE id = ? AND live_status = 'live'
  `).run(new Date().toISOString(), durationSeconds ?? null, id);
}

export function getLastActivityForGame(gameId: string): string | null {
  const row = db.prepare(`SELECT MAX(created_at) as last_activity FROM game_events WHERE game_id = ?`).get(gameId) as { last_activity: string | null } | undefined;
  return row?.last_activity ?? null;
}

export type GameOrderBy = 'recency' | 'duration';
export type GameOrderDir = 'asc' | 'desc';

export interface GameFilters {
  limit?: number;
  offset?: number;
  dateFrom?: string;
  dateTo?: string;
  errorsOnly?: boolean;
  devFilter?: 'all' | 'dev' | 'nodev';
  statusFilter?: 'all' | 'started' | 'finished' | 'abandoned' | 'live';
  hideGroups?: string[];
  hideRaw?: string[];
  hideDurationBuckets?: string[];
  hidePlayerCounts?: string[];
  playerName?: string;
  orderBy?: GameOrderBy;
  orderDir?: GameOrderDir;
}

type FilterDim = 'date' | 'errors' | 'dev' | 'status' | 'groups' | 'raw' | 'duration' | 'players' | 'playerName';

function durationBucketCondition(key: string): { sql: string; params: any[] } | null {
  if (key === 'unknown') return { sql: 'g.duration_seconds IS NULL', params: [] };
  const b = DURATION_BUCKETS[key];
  if (!b) return null;
  if (b.min !== null && b.max !== null) return { sql: 'g.duration_seconds BETWEEN ? AND ?', params: [b.min, b.max] };
  if (b.max !== null) return { sql: 'g.duration_seconds <= ?', params: [b.max] };
  if (b.min !== null) return { sql: 'g.duration_seconds >= ?', params: [b.min] };
  return null;
}

function buildConditions(filters: GameFilters, exclude: Set<FilterDim> = new Set()): { where: string; params: any[] } {
  const { dateFrom, dateTo, errorsOnly, devFilter = 'all', statusFilter = 'all', hideGroups = [], hideRaw = [], hideDurationBuckets = [], hidePlayerCounts = [] } = filters;
  const conditions: string[] = [];
  const params: any[] = [];

  if (!exclude.has('date')) {
    if (dateFrom) { conditions.push('COALESCE(NULLIF(g.finished_at, \'\'), g.started_at) >= ?'); params.push(dateFrom); }
    if (dateTo)   { conditions.push('COALESCE(NULLIF(g.finished_at, \'\'), g.started_at) <= ?'); params.push(dateTo); }
  }
  if (!exclude.has('errors') && errorsOnly) { conditions.push('g.has_error = 1'); }
  if (!exclude.has('dev')) {
    if (devFilter === 'dev')   conditions.push('g.is_dev = 1');
    if (devFilter === 'nodev') conditions.push('g.is_dev = 0');
  }
  if (!exclude.has('status')) {
    if (statusFilter === 'started')   conditions.push("g.status NOT IN ('lobby', '')");
    if (statusFilter === 'finished')  conditions.push("g.status = 'finished'");
    if (statusFilter === 'abandoned') conditions.push("g.live_status = 'abandoned'");
    if (statusFilter === 'live')      conditions.push("g.live_status = 'live'");
  }
  if (!exclude.has('groups')) {
    for (const g of hideGroups) {
      const members = STATUS_GROUPS[g];
      if (!members || members.length === 0) continue;
      const placeholders = members.map(() => '?').join(', ');
      conditions.push(`g.status NOT IN (${placeholders})`);
      params.push(...members);
    }
  }
  if (!exclude.has('raw')) {
    for (const r of hideRaw) {
      conditions.push('g.status != ?');
      params.push(r);
    }
  }
  if (!exclude.has('duration')) {
    for (const key of hideDurationBuckets) {
      const c = durationBucketCondition(key);
      if (!c) continue;
      conditions.push(`NOT (${c.sql})`);
      params.push(...c.params);
    }
  }
  if (!exclude.has('players')) {
    for (const key of hidePlayerCounts) {
      if (key === '7plus') { conditions.push('g.player_count < 7'); continue; }
      const n = Number(key);
      if (!Number.isFinite(n)) continue;
      conditions.push('g.player_count != ?');
      params.push(n);
    }
  }
  if (!exclude.has('playerName') && filters.playerName) {
    conditions.push('EXISTS (SELECT 1 FROM game_players gp WHERE gp.game_id = g.id AND LOWER(TRIM(gp.player_name)) = ?)');
    params.push(filters.playerName.trim().toLowerCase());
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  return { where, params };
}

export function getRecentGames(filters: GameFilters = {}): { games: GameSummary[]; total: number } {
  const { limit = 20, offset = 0, orderBy = 'recency', orderDir = 'desc' } = filters;
  const { where, params } = buildConditions(filters);

  const total = (db.prepare(`SELECT COUNT(*) as count FROM games g ${where}`).get(...params) as { count: number }).count;

  const dir = orderDir === 'asc' ? 'ASC' : 'DESC';
  const orderClause = orderBy === 'duration'
    ? `g.duration_seconds IS NULL, g.duration_seconds ${dir}, COALESCE(NULLIF(g.finished_at, ''), g.started_at) DESC`
    : `COALESCE(NULLIF(g.finished_at, ''), g.started_at) ${dir}`;

  const games = db.prepare(`
    SELECT g.id, g.started_at, g.finished_at, g.mode, g.room_code, g.host_name, g.rounds, g.player_count,
      g.winner_name, g.winner_score, g.duration_seconds, g.status, g.live_status, g.has_error, g.is_dev,
      g.api_version, g.client_version,
      (SELECT MAX(e.created_at) FROM game_events e WHERE e.game_id = g.id) as last_activity_at,
      (SELECT COUNT(*) FROM issue_reports ir WHERE ir.room_code = g.room_code AND g.room_code IS NOT NULL) as issue_count
    FROM games g ${where} ORDER BY ${orderClause} LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as GameSummary[];

  const getPlayers = db.prepare(`
    SELECT player_name, score, rank FROM game_players WHERE game_id = ? ORDER BY rank ASC
  `);

  for (const game of games) {
    game.players = getPlayers.all(game.id) as GamePlayerResult[];
  }

  return { games, total };
}

function countWhere(filters: GameFilters, exclude: Set<FilterDim>, extra?: { sql: string; params: any[] }): number {
  const { where, params } = buildConditions(filters, exclude);
  let sql = `SELECT COUNT(*) as count FROM games g`;
  const allParams = [...params];
  if (extra) {
    sql += where ? ` ${where} AND (${extra.sql})` : ` WHERE ${extra.sql}`;
    allParams.push(...extra.params);
  } else {
    sql += ` ${where}`;
  }
  return (db.prepare(sql).get(...allParams) as { count: number }).count;
}

export interface GameFilterCounts {
  total: number;
  date: { all: number; today: number; week: number; month: number };
  errors: { off: number; on: number };
  dev: { all: number; nodev: number; dev: number };
  status: { all: number; started: number; finished: number; abandoned: number; live: number };
  groups: Record<string, number>;
  raw: Record<string, number>;
  duration: Record<string, number>;
  players: Record<string, number>;
}

export function getGameFilterCounts(filters: GameFilters = {}): GameFilterCounts {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekDayDiff = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - weekDayDiff).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const dateCol = "COALESCE(NULLIF(g.finished_at, ''), g.started_at)";

  // total uses ALL active filters
  const total = countWhere(filters, new Set());

  // date breakdown: exclude date filter, intersect with each range
  const dateExcl: Set<FilterDim> = new Set(['date']);
  const date = {
    all:   countWhere(filters, dateExcl),
    today: countWhere(filters, dateExcl, { sql: `${dateCol} >= ?`, params: [todayStart] }),
    week:  countWhere(filters, dateExcl, { sql: `${dateCol} >= ?`, params: [weekStart] }),
    month: countWhere(filters, dateExcl, { sql: `${dateCol} >= ?`, params: [monthStart] }),
  };

  const errorsExcl: Set<FilterDim> = new Set(['errors']);
  const errors = {
    off: countWhere(filters, errorsExcl),
    on:  countWhere(filters, errorsExcl, { sql: 'g.has_error = 1', params: [] }),
  };

  const devExcl: Set<FilterDim> = new Set(['dev']);
  const dev = {
    all:   countWhere(filters, devExcl),
    nodev: countWhere(filters, devExcl, { sql: 'g.is_dev = 0', params: [] }),
    dev:   countWhere(filters, devExcl, { sql: 'g.is_dev = 1', params: [] }),
  };

  const statusExcl: Set<FilterDim> = new Set(['status']);
  const status = {
    all:       countWhere(filters, statusExcl),
    started:   countWhere(filters, statusExcl, { sql: "g.status NOT IN ('lobby', '')", params: [] }),
    finished:  countWhere(filters, statusExcl, { sql: "g.status = 'finished'", params: [] }),
    abandoned: countWhere(filters, statusExcl, { sql: "g.live_status = 'abandoned'", params: [] }),
    live:      countWhere(filters, statusExcl, { sql: "g.live_status = 'live'", params: [] }),
  };

  // groups + raw status counts: exclude groups+raw filters, then GROUP BY status
  const groupsExcl: Set<FilterDim> = new Set(['groups', 'raw']);
  const groupsWhere = buildConditions(filters, groupsExcl);
  const rawRows = db.prepare(
    `SELECT g.status as status, COUNT(*) as count FROM games g ${groupsWhere.where} GROUP BY g.status`
  ).all(...groupsWhere.params) as { status: string; count: number }[];

  const groups: Record<string, number> = {};
  const raw: Record<string, number> = {};
  for (const groupKey of Object.keys(STATUS_GROUPS)) groups[groupKey] = 0;
  for (const row of rawRows) {
    const statusKey = row.status ?? '';
    raw[statusKey] = (raw[statusKey] || 0) + row.count;
    let matched = false;
    for (const [groupKey, members] of Object.entries(STATUS_GROUPS)) {
      if (members.includes(statusKey)) { groups[groupKey] += row.count; matched = true; break; }
    }
    if (!matched) groups.other = (groups.other || 0) + row.count;
  }

  // duration: exclude duration filter, count each bucket
  const durExcl: Set<FilterDim> = new Set(['duration']);
  const duration: Record<string, number> = {};
  for (const key of Object.keys(DURATION_BUCKETS)) {
    const c = durationBucketCondition(key)!;
    duration[key] = countWhere(filters, durExcl, c);
  }
  duration.unknown = countWhere(filters, durExcl, { sql: 'g.duration_seconds IS NULL', params: [] });

  // players: exclude players filter, GROUP BY player_count
  const playersExcl: Set<FilterDim> = new Set(['players']);
  const playersWhere = buildConditions(filters, playersExcl);
  const playerRows = db.prepare(
    `SELECT g.player_count as pc, COUNT(*) as count FROM games g ${playersWhere.where} GROUP BY g.player_count ORDER BY pc ASC`
  ).all(...playersWhere.params) as { pc: number; count: number }[];

  const players: Record<string, number> = {};
  let sevenPlus = 0;
  for (const row of playerRows) {
    if (row.pc >= 7) { sevenPlus += row.count; continue; }
    players[String(row.pc)] = row.count;
  }
  if (sevenPlus > 0) players['7plus'] = sevenPlus;

  return { total, date, errors, dev, status, groups, raw, duration, players };
}

export function getGameById(id: string): GameDetail | null {
  const game = db.prepare(`
    SELECT id, started_at, finished_at, mode, room_code, host_name, rounds, player_count,
      winner_name, winner_score, duration_seconds, status, live_status, has_error, is_dev,
      api_version, client_version, settings_json
    FROM games WHERE id = ?
  `).get(id) as GameDetail | undefined;

  if (!game) return null;

  game.players = db.prepare(`
    SELECT player_name, score, rank FROM game_players WHERE game_id = ? ORDER BY rank ASC
  `).all(id) as GamePlayerResult[];

  // For live/abandoned games with no player results yet, derive from game_events
  if (game.players.length === 0 && (game.live_status === 'live' || game.live_status === 'abandoned')) {
    // Try game_started event first (has definitive player list and settings)
    const startedEvent = db.prepare(`
      SELECT data_json FROM game_events WHERE game_id = ? AND event_type = 'game_started' LIMIT 1
    `).get(id) as { data_json: string } | undefined;

    if (startedEvent?.data_json) {
      try {
        const data = JSON.parse(startedEvent.data_json);
        // Derive settings for live games
        if (!game.settings_json && data.settings) {
          game.settings_json = JSON.stringify(data.settings);
          if (data.settings.rounds) game.rounds = data.settings.rounds;
        }
        const playerNames: string[] = data.playerNames || [];
        // Count wins per player from winner_selected events
        const winEvents = db.prepare(`
          SELECT data_json FROM game_events WHERE game_id = ? AND event_type = 'winner_selected'
        `).all(id) as { data_json: string }[];
        const winCounts: Record<string, number> = {};
        for (const we of winEvents) {
          try {
            const wd = JSON.parse(we.data_json);
            if (wd.winnerName) winCounts[wd.winnerName] = (winCounts[wd.winnerName] || 0) + 1;
          } catch {}
        }
        game.players = playerNames.map((name, i) => ({
          player_name: name,
          score: winCounts[name] || 0,
          rank: i + 1,
        }));
      } catch {}
    } else {
      // Fall back to player_joined events
      const joinEvents = db.prepare(`
        SELECT actor_name FROM game_events WHERE game_id = ? AND event_type = 'player_joined' AND actor_name IS NOT NULL
      `).all(id) as { actor_name: string }[];
      const seen = new Set<string>();
      const names: string[] = [];
      for (const je of joinEvents) {
        if (!seen.has(je.actor_name)) {
          seen.add(je.actor_name);
          names.push(je.actor_name);
        }
      }
      game.players = names.map((name, i) => ({
        player_name: name,
        score: 0,
        rank: i + 1,
      }));
    }
  }

  game.card_plays = db.prepare(`
    SELECT round, phase, card_id, card_text, card_deck, player_name, is_winner
    FROM card_plays WHERE game_id = ? ORDER BY round ASC, is_winner DESC
  `).all(id) as GameDetailCardPlay[];

  // Fetch issue reports linked to this game's room_code
  if (game.room_code) {
    game.issues = db.prepare(
      'SELECT id, created_at, category, description, screen, phase, game_mode, device_info, client_version, error_log FROM issue_reports WHERE room_code = ? ORDER BY created_at ASC'
    ).all(game.room_code) as IssueReport[];
    game.issue_count = game.issues.length;
  } else {
    game.issues = [];
    game.issue_count = 0;
  }

  return game;
}

export function setGameDev(gameId: string, isDev: boolean): GameDetail | null {
  const result = db.prepare('UPDATE games SET is_dev = ? WHERE id = ?').run(isDev ? 1 : 0, gameId);
  if (result.changes === 0) return null;
  return getGameById(gameId);
}

export function setSurveyDev(surveyId: string, isDev: boolean): SurveyResponse | null {
  const result = db.prepare('UPDATE survey_responses SET is_dev = ? WHERE id = ?').run(isDev ? 1 : 0, surveyId);
  if (result.changes === 0) return null;
  const row = db.prepare(`
    SELECT id, created_at, game_id, player_name, session_id, nps_score, comment, improvement, client_version, is_dev
    FROM survey_responses WHERE id = ?
  `).get(surveyId) as SurveyResponse | undefined;
  return row ?? null;
}

export interface GamesStats {
  finishedGames: number;
  totalGames: number;
  unfinishedGames: number;
  abandonedGames: number;
  liveGames: number;
  totalPlayers: number;
  allPlayers: number;
  totalPlayTime: number;
  allPlayTime: number;
  avgPlayTime: number;
  medianPlayTime: number;
  longestPlayTime: number;
  shortestPlayTime: number;
  errorGames: number;
  issueGames: number;
}

export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function getGamesStats(filters: GameFilters = {}): GamesStats {
  // Total / unfinished / errors / players honor the full filter set (status filter included).
  const baseScope = buildConditions(filters);

  const totalGames = (db.prepare(`SELECT COUNT(*) as c FROM games g ${baseScope.where}`).get(...baseScope.params) as any).c;
  const errorGames = countWhere(filters, new Set(), { sql: 'g.has_error = 1', params: [] });
  const allPlayers = (db.prepare(`SELECT COALESCE(SUM(g.player_count), 0) as c FROM games g ${baseScope.where}`).get(...baseScope.params) as any).c;

  // Finished / abandoned / live counts ignore the status filter so a user filtering
  // by status=finished still sees how many of the remaining games are live, etc.
  const statusExcl: Set<FilterDim> = new Set(['status']);
  const finishedGames = countWhere(filters, statusExcl, { sql: "g.status = 'finished'", params: [] });
  const abandonedGames = countWhere(filters, statusExcl, { sql: "g.live_status = 'abandoned'", params: [] });
  const liveGames = countWhere(filters, statusExcl, { sql: "g.live_status = 'live'", params: [] });
  const unfinishedGames = Math.max(0, totalGames - finishedGames);

  const totalPlayers = (db.prepare(
    `SELECT COALESCE(SUM(g.player_count), 0) as c FROM games g ${baseScope.where}${baseScope.where ? ' AND' : ' WHERE'} g.status = 'finished'`
  ).get(...baseScope.params) as any).c;

  // Duration aggregates: only over games with a recorded duration_seconds.
  const durExtra = { sql: 'g.duration_seconds IS NOT NULL', params: [] as any[] };
  const durWhere = baseScope.where
    ? `${baseScope.where} AND ${durExtra.sql}`
    : `WHERE ${durExtra.sql}`;

  const totalPlayTime = (db.prepare(
    `SELECT COALESCE(SUM(g.duration_seconds), 0) as c FROM games g ${durWhere}`
  ).get(...baseScope.params) as any).c;
  const allPlayTime = totalPlayTime;
  const avgPlayTime = (db.prepare(
    `SELECT COALESCE(AVG(g.duration_seconds), 0) as c FROM games g ${durWhere}`
  ).get(...baseScope.params) as any).c;
  const longestPlayTime = (db.prepare(
    `SELECT COALESCE(MAX(g.duration_seconds), 0) as c FROM games g ${durWhere}`
  ).get(...baseScope.params) as any).c;
  const shortestPlayTime = (db.prepare(
    `SELECT COALESCE(MIN(g.duration_seconds), 0) as c FROM games g ${durWhere}`
  ).get(...baseScope.params) as any).c;

  const durations = db.prepare(
    `SELECT g.duration_seconds FROM games g ${durWhere}`
  ).all(...baseScope.params).map((r: any) => r.duration_seconds);
  const medianPlayTime = computeMedian(durations);

  // Issue count via correlated subquery (room_code → issue_reports), then count distinct games.
  const issueGames = (db.prepare(
    `SELECT COUNT(*) as c FROM games g ${baseScope.where}${baseScope.where ? ' AND' : ' WHERE'} g.room_code IS NOT NULL AND EXISTS (SELECT 1 FROM issue_reports ir WHERE ir.room_code = g.room_code)`
  ).get(...baseScope.params) as any).c;

  return {
    finishedGames, totalGames, unfinishedGames, abandonedGames, liveGames,
    totalPlayers, allPlayers, totalPlayTime, allPlayTime,
    avgPlayTime: Math.round(avgPlayTime),
    medianPlayTime: Math.round(medianPlayTime),
    longestPlayTime, shortestPlayTime,
    errorGames, issueGames,
  };
}

// Backwards-compatible wrappers — preserved for any external callers.
export function getStats(): GamesStats {
  return getGamesStats({});
}

export function getStatsByPeriod(since: string): GamesStats {
  return getGamesStats({ dateFrom: since });
}

export interface GameStateDuration {
  state: string;
  count: number;
  avg_seconds: number;
  median_seconds: number;
  total_seconds: number;
}

// Map a raw event.phase string into one of the base groups in STATUS_GROUPS.
// Exported so the algorithm and the mapping can be unit-tested independently of the DB.
export function mapPhaseToGroup(phase: string | null | undefined): string | null {
  if (!phase) return null;
  for (const [groupKey, members] of Object.entries(STATUS_GROUPS)) {
    if (members.includes(phase)) return groupKey;
  }
  return 'other';
}

export interface PhaseEventRow {
  game_id: string;
  finished_at: string | null;
  phase: string;
  created_at: string;
}

// Pure walker — given event rows ordered by (game_id, created_at), return the
// list of phase-durations (in seconds, grouped by base state). Extracted from
// getGameStateDurations so it's testable without a DB.
export function walkPhaseDurations(rows: PhaseEventRow[]): Record<string, number[]> {
  const buckets: Record<string, number[]> = {
    lobby: [], die: [], living: [], bye: [], eulogy: [], finished: [], other: [],
  };

  let curGame: string | null = null;
  let curPhase: string | null = null;
  let curPhaseStart: number | null = null;
  let lastGameFinishedAt: string | null = null;

  const record = (phase: string | null, startMs: number | null, endMs: number) => {
    if (!phase || startMs == null) return;
    const dur = Math.round((endMs - startMs) / 1000);
    if (!Number.isFinite(dur) || dur < 0) return;
    const group = mapPhaseToGroup(phase);
    if (group && buckets[group]) buckets[group].push(dur);
  };

  const flushFinalPhase = () => {
    if (!curPhase || curPhaseStart == null) return;
    if (!lastGameFinishedAt) return;
    const endMs = Date.parse(lastGameFinishedAt);
    if (!Number.isFinite(endMs) || endMs < curPhaseStart) return;
    record(curPhase, curPhaseStart, endMs);
  };

  for (const r of rows) {
    const ts = Date.parse(r.created_at);
    if (!Number.isFinite(ts)) continue;

    if (r.game_id !== curGame) {
      flushFinalPhase();
      curGame = r.game_id;
      lastGameFinishedAt = r.finished_at;
      curPhase = r.phase;
      curPhaseStart = ts;
      continue;
    }

    if (r.phase !== curPhase) {
      record(curPhase, curPhaseStart, ts);
      curPhase = r.phase;
      curPhaseStart = ts;
    }
  }
  flushFinalPhase();

  return buckets;
}

export function summariseStateBuckets(buckets: Record<string, number[]>): GameStateDuration[] {
  const orderedKeys = ['lobby', 'die', 'living', 'bye', 'eulogy', 'finished', 'other'];
  return orderedKeys.map(state => {
    const vals = buckets[state] || [];
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      state,
      count: vals.length,
      avg_seconds: vals.length > 0 ? Math.round(sum / vals.length) : 0,
      median_seconds: Math.round(computeMedian(vals)),
      total_seconds: sum,
    };
  });
}

export function getGameStateDurations(filters: GameFilters = {}): GameStateDuration[] {
  const baseScope = buildConditions(filters);
  const rows = db.prepare(`
    SELECT g.id as game_id, g.finished_at as finished_at,
           e.phase as phase, e.created_at as created_at
    FROM games g
    INNER JOIN game_events e ON e.game_id = g.id
    ${baseScope.where}${baseScope.where ? ' AND' : ' WHERE'} e.phase IS NOT NULL AND e.phase != ''
    ORDER BY g.id, e.created_at, e.id
  `).all(...baseScope.params) as PhaseEventRow[];

  return summariseStateBuckets(walkPhaseDurations(rows));
}

export type UserStatsDevFilter = 'all' | 'dev' | 'nodev';

export function getUserGameStats(opts: { devFilter?: UserStatsDevFilter; limit?: number } = {}): {
  players: UserGameStat[];
  total_distinct: number;
  total_matched_users: number;
} {
  const devFilter = opts.devFilter ?? 'nodev';
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);

  let devClause = '';
  if (devFilter === 'nodev') devClause = 'AND g.is_dev = 0';
  else if (devFilter === 'dev') devClause = 'AND g.is_dev = 1';

  const sql = `
    WITH player_agg AS (
      SELECT
        LOWER(TRIM(gp.player_name))            AS name_key,
        MIN(gp.player_name)                    AS display_name,
        COUNT(DISTINCT gp.game_id)             AS games_played,
        COALESCE(SUM(g.duration_seconds), 0)   AS total_seconds,
        MIN(g.finished_at)                     AS first_game_at,
        MAX(g.finished_at)                     AS last_game_at,
        COUNT(DISTINCT g.host_ip_hash)         AS distinct_host_ips,
        COUNT(DISTINCT g.host_user_id)         AS distinct_host_user_ids
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      WHERE 1=1 ${devClause}
      GROUP BY LOWER(TRIM(gp.player_name))
    ),
    user_match AS (
      SELECT
        LOWER(TRIM(display_name)) AS name_key,
        id, display_name, email, avatar_url,
        birth_month, birth_day, created_at,
        ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(display_name)) ORDER BY created_at) AS rn
      FROM users
    )
    SELECT
      p.name_key, p.display_name, p.games_played, p.total_seconds,
      p.first_game_at, p.last_game_at,
      p.distinct_host_ips, p.distinct_host_user_ids,
      u.id   AS matched_user_id,
      u.email, u.avatar_url, u.birth_month, u.birth_day,
      u.created_at AS matched_user_created_at
    FROM player_agg p
    LEFT JOIN user_match u ON u.name_key = p.name_key AND u.rn = 1
    ORDER BY p.total_seconds DESC, p.games_played DESC
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(limit) as UserGameStat[];

  const totalRow = db.prepare(`
    SELECT COUNT(DISTINCT LOWER(TRIM(gp.player_name))) AS total
    FROM game_players gp
    JOIN games g ON g.id = gp.game_id
    WHERE 1=1 ${devClause}
  `).get() as { total: number };

  const matched = rows.reduce((n, r) => n + (r.matched_user_id ? 1 : 0), 0);

  return {
    players: rows,
    total_distinct: totalRow.total ?? 0,
    total_matched_users: matched,
  };
}

export function saveCardPlays(plays: CardPlay[]): void {
  const insert = db.prepare(`
    INSERT INTO card_plays (game_id, round, phase, card_id, card_text, card_deck, player_name, is_winner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((items: CardPlay[]) => {
    for (const p of items) {
      insert.run(p.game_id, p.round, p.phase, p.card_id, p.card_text, p.card_deck, p.player_name, p.is_winner ? 1 : 0);
    }
  });

  transaction(plays);
}

export function saveCardDraws(draws: CardDraw[]): void {
  const insert = db.prepare(`
    INSERT INTO card_draws (game_id, phase, card_id, card_deck)
    VALUES (?, ?, ?, ?)
  `);

  const transaction = db.transaction((items: CardDraw[]) => {
    for (const d of items) {
      insert.run(d.game_id, d.phase, d.card_id, d.card_deck);
    }
  });

  transaction(draws);
}

export function getCardStats(devFilter: 'all' | 'dev' | 'nodev' = 'all'): { cards: CardStat[] } {
  let devWherePlay = '';
  let devWhereDraw = '';
  if (devFilter === 'dev') { devWherePlay = 'WHERE g.is_dev = 1'; devWhereDraw = 'WHERE g2.is_dev = 1'; }
  if (devFilter === 'nodev') { devWherePlay = 'WHERE g.is_dev = 0'; devWhereDraw = 'WHERE g2.is_dev = 0'; }

  // Build draw counts
  const drawCounts = db.prepare(`
    SELECT d.card_id, d.card_deck, COUNT(*) as draw_count
    FROM card_draws d
    JOIN games g2 ON d.game_id = g2.id
    ${devWhereDraw}
    GROUP BY d.card_id, d.card_deck
  `).all() as { card_id: string; card_deck: string; draw_count: number }[];

  const drawMap = new Map<string, number>();
  for (const d of drawCounts) {
    drawMap.set(`${d.card_deck}:${d.card_id}`, d.draw_count);
  }

  // Get play counts
  const playedCards = db.prepare(`
    SELECT cp.card_id, cp.card_text, cp.card_deck,
      COUNT(*) as play_count,
      SUM(cp.is_winner) as win_count
    FROM card_plays cp
    JOIN games g ON cp.game_id = g.id
    ${devWherePlay}
    GROUP BY cp.card_id, cp.card_deck
  `).all() as (CardStat & { win_count: number })[];

  // Build lookup of played cards keyed by "deck:id"
  const playedMap = new Map<string, CardStat & { win_count: number }>();
  for (const card of playedCards) {
    playedMap.set(`${card.card_deck}:${card.card_id}`, card);
  }

  // Merge all source cards with play + draw data (unplayed cards get zeros)
  const deckEntries: { cards: typeof DIE_CARDS; deck: string }[] = [
    { cards: DIE_CARDS, deck: 'die' },
    { cards: LIVING_CARDS, deck: 'living' },
    { cards: BYE_CARDS, deck: 'bye' },
  ];

  const allCards: CardStat[] = [];
  for (const { cards, deck } of deckEntries) {
    for (const c of cards) {
      const key = `${deck}:${String(c.id)}`;
      const played = playedMap.get(key);
      const dc = drawMap.get(key) || 0;
      if (played) {
        played.draw_count = dc;
        played.win_rate = played.play_count > 0 ? Math.round((played.win_count / played.play_count) * 100) : 0;
        played.play_rate = dc > 0 ? Math.round((played.play_count / dc) * 100) : 0;
        allCards.push(played);
        playedMap.delete(key);
      } else {
        allCards.push({ card_id: String(c.id), card_text: c.text, card_deck: deck, play_count: 0, win_count: 0, win_rate: 0, draw_count: dc, play_rate: 0 });
      }
    }
  }
  // Include expansion pack cards
  const expansionCards = db.prepare(`
    SELECT id, text, deck_type FROM expansion_cards
  `).all() as { id: string; text: string; deck_type: string }[];

  const deckTypeMap: Record<string, string> = { die: 'die', live: 'living', bye: 'bye' };

  for (const ec of expansionCards) {
    const deck = deckTypeMap[ec.deck_type] || ec.deck_type;
    const key = `${deck}:${ec.id}`;
    const played = playedMap.get(key);
    const dc = drawMap.get(key) || 0;
    if (played) {
      played.draw_count = dc;
      played.win_rate = played.play_count > 0 ? Math.round((played.win_count / played.play_count) * 100) : 0;
      played.play_rate = dc > 0 ? Math.round((played.play_count / dc) * 100) : 0;
      allCards.push(played);
      playedMap.delete(key);
    } else {
      allCards.push({ card_id: ec.id, card_text: ec.text, card_deck: deck, play_count: 0, win_count: 0, win_rate: 0, draw_count: dc, play_rate: 0 });
    }
  }

  // Include any played cards not in the source data (e.g. removed cards)
  for (const card of playedMap.values()) {
    const key = `${card.card_deck}:${card.card_id}`;
    const dc = drawMap.get(key) || 0;
    card.draw_count = dc;
    card.win_rate = card.play_count > 0 ? Math.round((card.win_count / card.play_count) * 100) : 0;
    card.play_rate = dc > 0 ? Math.round((card.play_count / dc) * 100) : 0;
    allCards.push(card);
  }

  // Default sort: play_rate desc, play_count desc, win_rate desc
  allCards.sort((a, b) => b.play_rate - a.play_rate || b.play_count - a.play_count || b.win_rate - a.win_rate);

  return { cards: allCards };
}

export function saveIssueReport(report: IssueReport): string {
  db.prepare(`
    INSERT INTO issue_reports (id, created_at, category, description, game_id, room_code,
      game_mode, screen, phase, player_count, players_json, game_state_json,
      device_info, error_log, client_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    report.id, report.created_at, report.category, report.description ?? null,
    report.game_id ?? null, report.room_code ?? null, report.game_mode ?? null,
    report.screen ?? null, report.phase ?? null, report.player_count ?? null,
    report.players_json ?? null, report.game_state_json ?? null,
    report.device_info ?? null, report.error_log ?? null, report.client_version ?? null
  );
  return report.id;
}

export function getIssueReports(limit = 50, offset = 0): { reports: IssueReport[]; total: number } {
  const total = (db.prepare('SELECT COUNT(*) as count FROM issue_reports').get() as { count: number }).count;
  const reports = db.prepare(
    'SELECT * FROM issue_reports ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset) as IssueReport[];
  return { reports, total };
}

export function saveGameEvent(event: GameEvent): void {
  db.prepare(`
    INSERT INTO game_events (game_id, room_id, event_type, actor_session_id, actor_name, phase, round, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.game_id ?? null,
    event.room_id,
    event.event_type,
    event.actor_session_id ?? null,
    event.actor_name ?? null,
    event.phase ?? null,
    event.round ?? null,
    event.data_json ?? null,
    event.created_at
  );
}

export function backfillGameId(roomId: string, gameId: string): void {
  db.prepare(`UPDATE game_events SET game_id = ? WHERE room_id = ? AND game_id IS NULL`).run(gameId, roomId);
}

export function getGameEvents(gameId: string): GameEventRow[] {
  return db.prepare(`
    SELECT id, game_id, room_id, event_type, actor_session_id, actor_name, phase, round, data_json, created_at
    FROM game_events WHERE game_id = ? ORDER BY created_at ASC, id ASC
  `).all(gameId) as GameEventRow[];
}

export function getGameEventsByRoom(roomId: string): GameEventRow[] {
  return db.prepare(`
    SELECT id, game_id, room_id, event_type, actor_session_id, actor_name, phase, round, data_json, created_at
    FROM game_events WHERE room_id = ? ORDER BY created_at ASC, id ASC
  `).all(roomId) as GameEventRow[];
}

// ── Surveys ──────────────────────────────────────────

export function saveSurveyResponse(r: SurveyResponse): boolean {
  const info = db.prepare(`
    INSERT OR IGNORE INTO survey_responses
      (id, created_at, game_id, player_name, session_id, nps_score, comment, improvement, client_version, is_dev)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.id, r.created_at, r.game_id ?? null, r.player_name ?? null,
    r.session_id ?? null, r.nps_score, r.comment ?? null,
    r.improvement ?? null, r.client_version ?? null, r.is_dev ? 1 : 0
  );
  return info.changes > 0;
}

export type SurveyDevFilter = 'all' | 'dev' | 'nodev';

function devWhere(filter: SurveyDevFilter): string {
  if (filter === 'dev') return 'WHERE is_dev = 1';
  if (filter === 'nodev') return 'WHERE is_dev = 0';
  return '';
}

export function getSurveyStats(devFilter: SurveyDevFilter = 'all'): SurveyStats {
  const where = devWhere(devFilter);
  const row = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(AVG(nps_score), 0) as avgNps,
      MIN(nps_score) as minNps,
      MAX(nps_score) as maxNps,
      SUM(CASE WHEN nps_score >= 9 THEN 1 ELSE 0 END) as promoters,
      SUM(CASE WHEN nps_score BETWEEN 7 AND 8 THEN 1 ELSE 0 END) as passives,
      SUM(CASE WHEN nps_score <= 6 THEN 1 ELSE 0 END) as detractors
    FROM survey_responses ${where}
  `).get() as any;

  const count = row.count as number;
  const promoters = row.promoters as number;
  const detractors = row.detractors as number;
  const nps = count > 0
    ? Math.round(((promoters / count) - (detractors / count)) * 100)
    : null;

  return {
    count,
    avgNps: count > 0 ? Math.round(row.avgNps * 10) / 10 : 0,
    minNps: count > 0 ? (row.minNps as number) : null,
    maxNps: count > 0 ? (row.maxNps as number) : null,
    nps,
    promoters,
    passives: row.passives as number,
    detractors,
  };
}

export function getSurveyResponses(limit = 50, offset = 0, devFilter: SurveyDevFilter = 'all'): { responses: SurveyResponse[]; total: number } {
  const where = devWhere(devFilter);
  const total = (db.prepare(`SELECT COUNT(*) as c FROM survey_responses ${where}`).get() as { c: number }).c;
  const responses = db.prepare(`
    SELECT id, created_at, game_id, player_name, session_id, nps_score, comment, improvement, client_version, is_dev
    FROM survey_responses ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset) as SurveyResponse[];
  return { responses, total };
}

// ── Mailing list ───────────────────────────────────────────

export function saveMailingListEntry(id: string, email: string, playerName?: string, source?: string): boolean {
  const info = db.prepare(`
    INSERT OR IGNORE INTO mailing_list (id, email, player_name, source, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, email, playerName || null, source || null, new Date().toISOString());
  return info.changes > 0;
}
