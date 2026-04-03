import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import type { GameResult, GameSummary, GameDetail, GamePlayerResult } from './types.js';

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
      finished_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      room_code TEXT,
      rounds INTEGER NOT NULL,
      player_count INTEGER NOT NULL,
      winner_name TEXT NOT NULL,
      winner_score INTEGER NOT NULL,
      duration_seconds INTEGER,
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
  `);
}

export function saveGameResult(result: GameResult): string {
  const insertGame = db.prepare(`
    INSERT INTO games (id, finished_at, mode, room_code, rounds, player_count, winner_name, winner_score, duration_seconds, settings_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPlayer = db.prepare(`
    INSERT INTO game_players (game_id, player_name, score, rank)
    VALUES (?, ?, ?, ?)
  `);

  const transaction = db.transaction((r: GameResult) => {
    insertGame.run(
      r.id, r.finished_at, r.mode, r.room_code ?? null,
      r.rounds, r.player_count, r.winner_name, r.winner_score,
      r.duration_seconds ?? null, r.settings_json ?? null
    );
    for (const p of r.players) {
      insertPlayer.run(r.id, p.player_name, p.score, p.rank);
    }
    return r.id;
  });

  return transaction(result);
}

export function getRecentGames(limit = 20, offset = 0): { games: GameSummary[]; total: number } {
  const total = (db.prepare('SELECT COUNT(*) as count FROM games').get() as { count: number }).count;

  const games = db.prepare(`
    SELECT id, finished_at, mode, room_code, rounds, player_count, winner_name, winner_score, duration_seconds
    FROM games ORDER BY finished_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset) as GameSummary[];

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
    SELECT id, finished_at, mode, room_code, rounds, player_count, winner_name, winner_score, duration_seconds, settings_json
    FROM games WHERE id = ?
  `).get(id) as GameDetail | undefined;

  if (!game) return null;

  game.players = db.prepare(`
    SELECT player_name, score, rank FROM game_players WHERE game_id = ? ORDER BY rank ASC
  `).all(id) as GamePlayerResult[];

  return game;
}
