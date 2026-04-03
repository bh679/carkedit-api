import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import type { GameResult, GameSummary, GameDetail, GameDetailCardPlay, GamePlayerResult, CardPlay, CardStat, IssueReport, GameEvent, GameEventRow } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/games.db');

let db: Database.Database;

export function initDatabase(): void {
  db = new Database(DB_PATH);
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
      settings_json TEXT
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
  ];
  for (const [col, sql] of migrations) {
    if (!cols.includes(col)) {
      db.exec(sql);
    }
  }
}

export function saveGameResult(result: GameResult): string {
  const insertGame = db.prepare(`
    INSERT INTO games (id, started_at, finished_at, mode, room_code, host_name, rounds, player_count,
      winner_name, winner_score, duration_seconds, status, live_status, has_error, is_dev,
      api_version, client_version, settings_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      r.api_version ?? null, r.client_version ?? null, r.settings_json ?? null
    );
    for (const p of r.players) {
      insertPlayer.run(r.id, p.player_name, p.score, p.rank);
    }
    return r.id;
  });

  return transaction(result);
}

export interface GameFilters {
  limit?: number;
  offset?: number;
  dateFrom?: string;
  dateTo?: string;
  errorsOnly?: boolean;
  devFilter?: 'all' | 'dev' | 'nodev';
  statusFilter?: 'all' | 'finished' | 'unfinished';
}

export function getRecentGames(filters: GameFilters = {}): { games: GameSummary[]; total: number } {
  const { limit = 20, offset = 0, dateFrom, dateTo, errorsOnly, devFilter = 'all', statusFilter = 'all' } = filters;

  const conditions: string[] = [];
  const params: any[] = [];

  if (dateFrom) { conditions.push('finished_at >= ?'); params.push(dateFrom); }
  if (dateTo) { conditions.push('finished_at <= ?'); params.push(dateTo); }
  if (errorsOnly) { conditions.push('has_error = 1'); }
  if (devFilter === 'dev') { conditions.push('is_dev = 1'); }
  if (devFilter === 'nodev') { conditions.push('is_dev = 0'); }
  if (statusFilter === 'finished') { conditions.push("status = 'finished'"); }
  if (statusFilter === 'unfinished') { conditions.push("status != 'finished'"); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = (db.prepare(`SELECT COUNT(*) as count FROM games ${where}`).get(...params) as { count: number }).count;

  const games = db.prepare(`
    SELECT id, started_at, finished_at, mode, room_code, host_name, rounds, player_count,
      winner_name, winner_score, duration_seconds, status, live_status, has_error, is_dev,
      api_version, client_version
    FROM games ${where} ORDER BY finished_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as GameSummary[];

  const getPlayers = db.prepare(`
    SELECT player_name, score, rank FROM game_players WHERE game_id = ? ORDER BY rank ASC
  `);

  for (const game of games) {
    game.players = getPlayers.all(game.id) as GamePlayerResult[];
  }

  return { games, total };
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

  game.card_plays = db.prepare(`
    SELECT round, phase, card_id, card_text, card_deck, player_name, is_winner
    FROM card_plays WHERE game_id = ? ORDER BY round ASC, is_winner DESC
  `).all(id) as GameDetailCardPlay[];

  return game;
}

export function getStats(): { finishedGames: number; totalGames: number; unfinishedGames: number; totalPlayers: number; totalPlayTime: number; avgPlayTime: number; medianPlayTime: number; longestPlayTime: number } {
  const finishedGames = (db.prepare("SELECT COUNT(*) as c FROM games WHERE status = 'finished'").get() as any).c;
  const totalGames = (db.prepare("SELECT COUNT(*) as c FROM games").get() as any).c;
  const unfinishedGames = totalGames - finishedGames;
  const totalPlayers = (db.prepare("SELECT COALESCE(SUM(player_count), 0) as c FROM games WHERE status = 'finished'").get() as any).c;
  const totalPlayTime = (db.prepare("SELECT COALESCE(SUM(duration_seconds), 0) as c FROM games WHERE duration_seconds IS NOT NULL").get() as any).c;
  const avgPlayTime = (db.prepare("SELECT COALESCE(AVG(duration_seconds), 0) as c FROM games WHERE duration_seconds IS NOT NULL").get() as any).c;

  // Median
  const durations = db.prepare("SELECT duration_seconds FROM games WHERE duration_seconds IS NOT NULL ORDER BY duration_seconds").all().map((r: any) => r.duration_seconds);
  let medianPlayTime = 0;
  if (durations.length > 0) {
    const mid = Math.floor(durations.length / 2);
    medianPlayTime = durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];
  }

  const longestPlayTime = (db.prepare("SELECT COALESCE(MAX(duration_seconds), 0) as c FROM games WHERE duration_seconds IS NOT NULL").get() as any).c;

  return { finishedGames, totalGames, unfinishedGames, totalPlayers, totalPlayTime, avgPlayTime: Math.round(avgPlayTime), medianPlayTime: Math.round(medianPlayTime), longestPlayTime };
}

export function getStatsByPeriod(since: string): { finishedGames: number; totalGames: number; unfinishedGames: number; totalPlayers: number; totalPlayTime: number; avgPlayTime: number; medianPlayTime: number; longestPlayTime: number } {
  const finishedGames = (db.prepare("SELECT COUNT(*) as c FROM games WHERE status = 'finished' AND finished_at >= ?").get(since) as any).c;
  const totalGames = (db.prepare("SELECT COUNT(*) as c FROM games WHERE finished_at >= ?").get(since) as any).c;
  const unfinishedGames = totalGames - finishedGames;
  const totalPlayers = (db.prepare("SELECT COALESCE(SUM(player_count), 0) as c FROM games WHERE status = 'finished' AND finished_at >= ?").get(since) as any).c;
  const totalPlayTime = (db.prepare("SELECT COALESCE(SUM(duration_seconds), 0) as c FROM games WHERE duration_seconds IS NOT NULL AND finished_at >= ?").get(since) as any).c;
  const avgPlayTime = (db.prepare("SELECT COALESCE(AVG(duration_seconds), 0) as c FROM games WHERE duration_seconds IS NOT NULL AND finished_at >= ?").get(since) as any).c;

  const durations = db.prepare("SELECT duration_seconds FROM games WHERE duration_seconds IS NOT NULL AND finished_at >= ? ORDER BY duration_seconds").all(since).map((r: any) => r.duration_seconds);
  let medianPlayTime = 0;
  if (durations.length > 0) {
    const mid = Math.floor(durations.length / 2);
    medianPlayTime = durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];
  }

  const longestPlayTime = (db.prepare("SELECT COALESCE(MAX(duration_seconds), 0) as c FROM games WHERE duration_seconds IS NOT NULL AND finished_at >= ?").get(since) as any).c;

  return { finishedGames, totalGames, unfinishedGames, totalPlayers, totalPlayTime, avgPlayTime: Math.round(avgPlayTime), medianPlayTime: Math.round(medianPlayTime), longestPlayTime };
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

export function getCardStats(): { mostPlayed: CardStat[]; leastPlayed: CardStat[]; highestWinRate: CardStat[] } {
  const allCards = db.prepare(`
    SELECT card_id, card_text, card_deck,
      COUNT(*) as play_count,
      SUM(is_winner) as win_count
    FROM card_plays
    GROUP BY card_id, card_deck
    ORDER BY play_count DESC
  `).all() as (CardStat & { win_count: number })[];

  for (const card of allCards) {
    card.win_rate = card.play_count > 0 ? Math.round((card.win_count / card.play_count) * 100) : 0;
  }

  const mostPlayed = allCards.slice(0, 20);
  const leastPlayed = [...allCards].sort((a, b) => a.play_count - b.play_count).slice(0, 20);
  const highestWinRate = allCards.filter(c => c.play_count >= 3).sort((a, b) => b.win_rate - a.win_rate).slice(0, 20);

  return { mostPlayed, leastPlayed, highestWinRate };
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
