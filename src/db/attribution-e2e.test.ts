import {
  initDatabase,
  createLiveGame,
  completeLiveGame,
  getGamesStats,
  getUserGameStats,
  getGameById,
} from './database.js';
import { createUser, upsertUserFromFirebase } from './users.js';
import { createBrand } from './brands.js';

// One test that chains the whole attribution flow the way the live app does:
// signup on a brand URL → users.brand_id; host a game on the brand URL →
// games.brand_id; brand-scoped stats reflect ONLY that brand's activity.
describe('end-to-end brand attribution (signup → host → stats)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  it('attributes a signup + hosted game to the brand, and scopes stats to it', () => {
    // Approved brand owned by someone.
    const owner = createUser({ display_name: 'Owner', firebase_uid: 'uid_owner', email: 'owner@example.com' });
    const brand = createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id, status: 'approved' });

    // (1) SIGNUP attribution — a new account created while on the brand URL.
    const player = upsertUserFromFirebase({ uid: 'uid_p', email: 'p@example.com', name: 'Pat', email_verified: true }, brand.id);
    expect(player.brand_id).toBe(brand.id);

    // (2) PLAY attribution — that user hosts a game created on the brand URL.
    createLiveGame({ id: 'g1', started_at: '2026-06-26T00:00:00.000Z', mode: 'online', player_count: 2, is_dev: false, host_user_id: player.id, brand_id: brand.id });
    completeLiveGame('g1', {
      finished_at: '2026-06-26T00:10:00.000Z', rounds: 1, player_count: 2,
      winner_name: 'Pat', winner_score: 5, duration_seconds: 600, has_error: false, is_dev: false,
      host_user_id: player.id,
      players: [{ player_name: 'Pat', score: 5, rank: 1 }, { player_name: 'Sam', score: 3, rank: 2 }],
    });
    expect(getGameById('g1')?.live_status).toBe('completed');

    // (3) A control game NOT on the brand (no brand_id).
    createLiveGame({ id: 'g2', started_at: '2026-06-26T01:00:00.000Z', mode: 'online', player_count: 1, is_dev: false });
    completeLiveGame('g2', {
      finished_at: '2026-06-26T01:10:00.000Z', rounds: 1, player_count: 1,
      winner_name: 'Zed', winner_score: 4, duration_seconds: 300, has_error: false, is_dev: false,
      players: [{ player_name: 'Zed', score: 4, rank: 1 }],
    });

    // Game stats: global counts both; brand scope counts ONLY the brand game.
    expect(getGamesStats({}).totalGames).toBe(2);
    expect(getGamesStats({ brandId: brand.id }).totalGames).toBe(1);

    // Player stats: brand scope = those who played the brand game (Pat + Sam),
    // not the control game's Zed.
    const brandPlayers = getUserGameStats({ devFilter: 'all', brandId: brand.id }).players.map((p) => p.display_name).sort();
    expect(brandPlayers).toEqual(['Pat', 'Sam']);

    // The signup (Pat) carries their signup brand; the anonymous Sam doesn't.
    const withAccts = getUserGameStats({ devFilter: 'all', brandId: brand.id, includeAccounts: true }).players;
    const pat = withAccts.find((p) => p.display_name === 'Pat');
    const sam = withAccts.find((p) => p.display_name === 'Sam');
    expect(pat?.matched_user_id).toBe(player.id);
    expect(pat?.signup_brand_id).toBe(brand.id);
    expect(sam?.matched_user_id).toBeNull();   // anonymous joiner, no account
  });
});
