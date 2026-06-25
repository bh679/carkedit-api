import { initDatabase, saveGameResult, getGameById, gameBelongsToBrand } from './database.js';
import { createUser } from './users.js';
import { createBrand } from './brands.js';
import type { GameResult } from './types.js';

// A game's brand is DERIVED from its host (games.host_user_id → users.brand_id),
// so we tag the *host* with a brand and assert gameBelongsToBrand picks it up.
// This backs the owner-gated GET /api/carkedit/brands/:id/games/:gameId route,
// which 404s any game the helper rejects.
function hostedGame(id: string, hostUserId: string | undefined): GameResult {
  return {
    id,
    finished_at: '2026-06-01T00:00:00.000Z',
    mode: 'online',
    rounds: 1,
    player_count: 3,
    winner_name: 'W',
    winner_score: 5,
    status: 'finished',
    live_status: 'completed',
    has_error: false,
    is_dev: false,
    host_user_id: hostUserId,
    players: [{ player_name: 'W', score: 5, rank: 1 }],
  };
}

describe('gameBelongsToBrand (derived host_user_id → users.brand_id)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  function seed() {
    const owner = createUser({ display_name: 'Owner', firebase_uid: 'uid_owner', email: 'owner@example.com' });
    const brand = createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id, status: 'approved' });
    const member = createUser({ display_name: 'A', firebase_uid: 'uid_a', email: 'a@example.com', brand_id: brand.id });
    const outsider = createUser({ display_name: 'C', firebase_uid: 'uid_c', email: 'c@example.com' });
    // A second brand, to prove cross-brand games are rejected.
    const owner2 = createUser({ display_name: 'Owner2', firebase_uid: 'uid_owner2', email: 'owner2@example.com' });
    const brand2 = createBrand({ slug: 'beta', name: 'Beta', owner_user_id: owner2.id, status: 'approved' });
    const member2 = createUser({ display_name: 'D', firebase_uid: 'uid_d', email: 'd@example.com', brand_id: brand2.id });
    saveGameResult(hostedGame('g_brand', member.id));      // hosted by a brand member
    saveGameResult(hostedGame('g_outsider', outsider.id));  // host has no brand
    saveGameResult(hostedGame('g_nullhost', undefined));    // legacy null host
    saveGameResult(hostedGame('g_brand2', member2.id));     // hosted by a DIFFERENT brand
    return { brand, brand2 };
  }

  it('returns true for a game hosted by a brand member', () => {
    const { brand } = seed();
    expect(gameBelongsToBrand('g_brand', brand.id)).toBe(true);
  });

  it('returns false for a game hosted by a non-brand user', () => {
    const { brand } = seed();
    expect(gameBelongsToBrand('g_outsider', brand.id)).toBe(false);
  });

  it('returns false for a legacy game with a null host', () => {
    const { brand } = seed();
    expect(gameBelongsToBrand('g_nullhost', brand.id)).toBe(false);
  });

  it("returns false for another brand's game (cross-brand isolation)", () => {
    const { brand } = seed();
    expect(gameBelongsToBrand('g_brand2', brand.id)).toBe(false);
  });

  it('returns false for a non-existent game id', () => {
    const { brand } = seed();
    expect(gameBelongsToBrand('nope', brand.id)).toBe(false);
  });

  it('the in-brand game is itself fetchable via getGameById (route composes the two)', () => {
    seed();
    const game = getGameById('g_brand');
    expect(game?.id).toBe('g_brand');
  });
});
