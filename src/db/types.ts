export interface GamePlayerResult {
  player_name: string;
  score: number;
  rank: number;
}

export interface GameResult {
  id: string;
  finished_at: string;
  mode: 'online' | 'local';
  room_code?: string;
  rounds: number;
  player_count: number;
  winner_name: string;
  winner_score: number;
  duration_seconds?: number;
  settings_json?: string;
  players: GamePlayerResult[];
}

export interface GameSummary {
  id: string;
  finished_at: string;
  mode: string;
  room_code: string | null;
  rounds: number;
  player_count: number;
  winner_name: string;
  winner_score: number;
  duration_seconds: number | null;
  players: GamePlayerResult[];
}

export interface GameDetail extends GameSummary {
  settings_json: string | null;
}
