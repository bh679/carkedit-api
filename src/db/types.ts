export type GameStatus = 'lobby' | 'die' | 'live' | 'bye' | 'eulogy' | 'finished';
export type GameLiveStatus = 'live' | 'abandoned' | 'completed';

export interface GamePlayerResult {
  player_name: string;
  score: number;
  rank: number;
}

export interface GameResult {
  id: string;
  started_at?: string;
  finished_at: string;
  mode: 'online' | 'local';
  room_code?: string;
  host_name?: string;
  rounds: number;
  player_count: number;
  winner_name: string;
  winner_score: number;
  duration_seconds?: number;
  status: GameStatus;
  live_status: GameLiveStatus;
  has_error: boolean;
  is_dev: boolean;
  api_version?: string;
  client_version?: string;
  settings_json?: string;
  players: GamePlayerResult[];
}

export interface GameSummary {
  id: string;
  started_at: string | null;
  finished_at: string;
  mode: string;
  room_code: string | null;
  host_name: string | null;
  rounds: number;
  player_count: number;
  winner_name: string;
  winner_score: number;
  duration_seconds: number | null;
  status: string;
  live_status: string;
  has_error: number;
  is_dev: number;
  api_version: string | null;
  client_version: string | null;
  players: GamePlayerResult[];
}

export interface GameDetail extends GameSummary {
  settings_json: string | null;
}
