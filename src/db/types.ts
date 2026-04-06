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
  last_activity_at: string | null;
  players: GamePlayerResult[];
}

export interface GameDetailCardPlay {
  round: number;
  phase: string;
  card_id: string;
  card_text: string;
  card_deck: string;
  player_name: string;
  is_winner: number;
}

export interface GameDetail extends GameSummary {
  settings_json: string | null;
  card_plays: GameDetailCardPlay[];
}

export interface CardPlay {
  game_id: string;
  round: number;
  phase: string;
  card_id: string;
  card_text: string;
  card_deck: string;
  player_name: string;
  is_winner: boolean;
}

export interface CardDraw {
  game_id: string;
  phase: string;
  card_id: string;
  card_deck: string;
}

export interface CardStat {
  card_id: string;
  card_text: string;
  card_deck: string;
  play_count: number;
  win_count: number;
  win_rate: number;
  draw_count: number;
  play_rate: number;
}

export interface IssueReport {
  id: string;
  created_at: string;
  category: string;
  description?: string;
  game_id?: string;
  room_code?: string;
  game_mode?: string;
  screen?: string;
  phase?: string;
  player_count?: number;
  players_json?: string;
  game_state_json?: string;
  device_info?: string;
  error_log?: string;
  client_version?: string;
}

export interface GameEvent {
  room_id: string;
  game_id?: string;
  event_type: string;
  actor_session_id?: string;
  actor_name?: string;
  phase?: string;
  round?: number;
  data_json?: string;
  created_at: string;
}

export interface GameEventRow {
  id: number;
  room_id: string;
  game_id: string | null;
  event_type: string;
  actor_session_id: string | null;
  actor_name: string | null;
  phase: string | null;
  round: number | null;
  data_json: string | null;
  created_at: string;
}

export interface User {
  id: string;
  firebase_uid: string | null;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  is_admin: number;
  birth_month: number;
  birth_day: number;
  created_at: string;
  updated_at: string;
}

export interface ExpansionPack {
  id: string;
  creator_id: string;
  title: string;
  description: string;
  visibility: 'private' | 'public';
  status: 'draft' | 'published';
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ExpansionCard {
  id: string;
  pack_id: string;
  deck_type: 'die' | 'live' | 'bye';
  text: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PackWithCards extends ExpansionPack {
  cards: ExpansionCard[];
}
