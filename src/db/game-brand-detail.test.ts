import { initDatabase, saveGameResult, createLiveGame, getGameById, gameBelongsToBrand } from './database.js';
import { createUser } from './users.js';
import { createBrand } from './brands.js';
import type { GameResult } from './types.js';

// A game's brand is its PLAY attribution (games.brand_id — the brand URL it was
// created on), so we tag the game directly. This backs the owner-gated
// GET /api/carkedit/brands/:id/games/:gameId route, which 404s any game the
// helper rejects.
function game(id: string, brandId?: string | null): GameResult {
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
    brand_id: brandId ?? null,
    players: [{ player_name: 'W', score: 5, rank: 1 }],
  };
}

describe('gameBelongsToBrand (games.brand_id play attribution)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  function seed() {
    const owner = createUser({ display_name: 'Owner', firebase_uid: 'uid_owner', email: 'owner@example.com' });
    const brand = createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id, status: 'approved' });
    const owner2 = createUser({ display_name: 'Owner2', firebase_uid: 'uid_owner2', email: 'owner2@example.com' });
    const brand2 = createBrand({ slug: 'beta', name: 'Beta', owner_user_id: owner2.id, status: 'approved' });
    saveGameResult(game('g_brand', brand.id));    // created on this brand's URL
    saveGameResult(game('g_untagged'));            // no brand tag
    saveGameResult(game('g_brand2', brand2.id));   // created on a DIFFERENT brand's URL
    return { brand, brand2 };
  }

  it('returns true for a game tagged with the brand', () => {
    const { brand } = seed();
    expect(gameBelongsToBrand('g_brand', brand.id)).toBe(true);
  });

  it('returns false for an untagged game', () => {
    const { brand } = seed();
    expect(gameBelongsToBrand('g_untagged', brand.id)).toBe(false);
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
    expect(getGameById('g_brand')?.id).toBe('g_brand');
  });

  it('createLiveGame tags + validates brand_id (live games are brand-scoped too)', () => {
    const { brand } = seed();
    createLiveGame({ id: 'live_ok', started_at: '2026-06-01T00:00:00.000Z', mode: 'online', player_count: 0, is_dev: false, brand_id: brand.id });
    createLiveGame({ id: 'live_bad', started_at: '2026-06-01T00:00:00.000Z', mode: 'online', player_count: 0, is_dev: false, brand_id: 'brand_does_not_exist' });
    expect(gameBelongsToBrand('live_ok', brand.id)).toBe(true);
    expect(gameBelongsToBrand('live_bad', brand.id)).toBe(false); // unknown brand dropped to null
  });
});
