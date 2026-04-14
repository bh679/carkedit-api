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
  issue_count: number;
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
  issues: IssueReport[];
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
  status: 'draft' | 'published';
  is_official: boolean;
  is_dev: boolean;
  is_favorited?: boolean;
  version: number;
  featured_card_id: string | null;
  brand_image_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExpansionCard {
  id: string;
  pack_id: string;
  deck_type: 'die' | 'live' | 'bye';
  text: string;
  prompt: string | null;
  card_special: string | null;
  options_json: string | null;
  image_url: string | null;
  text_position: string | null;
  text_color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PackWithCards extends ExpansionPack {
  cards: ExpansionCard[];
}

/**
 * A row in the `generation_log` table — one per Generate click on
 * the admin-image-gen test page. Captures the full card context +
 * the locally-downloaded image path so the Recent generations
 * gallery can replay it even after the provider URL has expired.
 */
export interface GenerationLogEntry {
  id: string;
  creator_id: string | null;
  deck_type: 'die' | 'live' | 'bye';
  text: string;
  prompt: string | null;
  card_special: string | null;
  options_json: string | null;
  image_url: string;           // /uploads/card-images/gen-*.{png,jpg,webp}
  image_url_b: string | null;  // reserved for dual-image split cards
  provider: string;            // e.g. 'flux-2-pro'
  prompt_sent: string;         // exact final prompt sent upstream
  tokens_used: number | null;  // provider credits/tokens consumed (null = pre-tracking)
  cost_usd: number | null;     // estimated cost in USD (null = pre-tracking)
  pack_id: string | null;      // expansion pack this generation was for (null = scratch/unknown)
  card_id: string | null;      // expansion card this generation was for (null = scratch/unknown)
  created_at: string;
}

/** Unified cost entry — remote reports, AWS/Cloudflare, manual, etc. */
export interface CostEntry {
  id: string;
  service: string;
  category: string;
  description: string;
  amount_usd: number;
  period_start: string;
  period_end: string;
  environment: string;
  source: string;
  source_ref: string | null;
  entered_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SurveyResponse {
  id: string;
  created_at: string;
  game_id?: string;
  player_name?: string;
  session_id?: string;
  nps_score: number;
  comment?: string;
  improvement?: string;
  client_version?: string;
  is_dev?: boolean;
}

export interface SurveyStats {
  count: number;
  avgNps: number;
  minNps: number | null;
  maxNps: number | null;
  nps: number | null;
  promoters: number;
  passives: number;
  detractors: number;
}
