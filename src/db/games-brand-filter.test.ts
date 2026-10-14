import { initDatabase, saveGameResult, getRecentGames, getGamesStats } from './database.js';
import { createUser } from './users.js';
import { createBrand } from './brands.js';
import type { GameResult } from './types.js';

// Minimal finished game. A game's brand is its PLAY attribution — games.brand_id,
// the brand URL the game was created on (set at creation, validated to a real
// brand) — NOT derived from the host. So we tag the *game* and assert
// brand-scoped queries pick it up. brand_id of '' / unknown is dropped to null.
function game(id: string, winnerName: string, brandId?: string | null): GameResult {
  return {
    id,
    finished_at: '2026-06-01T00:00:00.000Z',
    mode: 'online',
    rounds: 1,
    player_count: 3,
    winner_name: winnerName,
    winner_score: 5,
    status: 'finished',
    live_status: 'completed',
    has_error: false,
    is_dev: false,
    brand_id: brandId ?? null,
    players: [{ player_name: winnerName, score: 5, rank: 1 }],
  };
}

describe('brand-scoped game queries (games.brand_id play attribution)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  function seed() {
    const owner = createUser({ display_name: 'Owner', firebase_uid: 'uid_owner', email: 'owner@example.com' });
    const brand = createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id, status: 'approved' });
    return { brand };
  }

  it('getRecentGames returns only games tagged with the brand', () => {
    const { brand } = seed();
    saveGameResult(game('g1', 'Alice', brand.id));
    saveGameResult(game('g2', 'Carol'));            // no brand tag
    saveGameResult(game('g3', 'Bob', brand.id));
    saveGameResult(game('g4', 'Legacy', null));     // untagged (legacy) → never a brand game

    const result = getRecentGames({ brandId: brand.id });

    expect(result.total).toBe(2);
    expect(result.games.map((g) => g.id).sort()).toEqual(['g1', 'g3']);
  });

  it('getGamesStats counts only the brand-tagged games and their players', () => {
    const { brand } = seed();
    saveGameResult(game('g1', 'Alice', brand.id));  // 3 players
    saveGameResult(game('g2', 'Alice2', brand.id)); // 3 players
    saveGameResult(game('g3', 'Carol'));            // excluded

    const scoped = getGamesStats({ brandId: brand.id });
    expect(scoped.totalGames).toBe(2);
    expect(scoped.finishedGames).toBe(2);
    expect(scoped.allPlayers).toBe(6);

    // Sanity: unscoped sees all three.
    expect(getGamesStats({}).totalGames).toBe(3);
  });

  it('drops an unknown brand_id to null (not tagged to any brand)', () => {
    const { brand } = seed();
    saveGameResult(game('g1', 'Alice', 'brand_does_not_exist'));
    expect(getRecentGames({ brandId: brand.id }).total).toBe(0);
    // and it's still globally visible
    expect(getRecentGames({}).total).toBe(1);
  });

  it('returns nothing for a brand with no tagged games', () => {
    const { brand } = seed();
    const otherOwner = createUser({ display_name: 'O2', firebase_uid: 'uid_o2', email: 'o2@example.com' });
    const emptyBrand = createBrand({ slug: 'empty', name: 'Empty', owner_user_id: otherOwner.id, status: 'approved' });
    saveGameResult(game('g1', 'Carol', brand.id));

    expect(getRecentGames({ brandId: emptyBrand.id }).total).toBe(0);
    expect(getGamesStats({ brandId: emptyBrand.id }).totalGames).toBe(0);
  });

  it('does not filter by brand when brandId is omitted', () => {
    const { brand } = seed();
    saveGameResult(game('g1', 'Alice', brand.id));
    saveGameResult(game('g2', 'Carol'));

    expect(getRecentGames({}).total).toBe(2);
  });
});
