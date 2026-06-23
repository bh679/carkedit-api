import { initDatabase, saveGameResult, getRecentGames, getGamesStats } from './database.js';
import { createUser } from './users.js';
import { createBrand } from './brands.js';
import type { GameResult } from './types.js';

// Minimal finished game hosted by `hostUserId`. A game's brand is DERIVED from
// its host (games.host_user_id → users.brand_id), so we tag the *host* with a
// brand and assert brand-scoped queries pick the game up.
function hostedGame(id: string, hostUserId: string | undefined, winnerName: string): GameResult {
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
    host_user_id: hostUserId,
    players: [{ player_name: winnerName, score: 5, rank: 1 }],
  };
}

describe('brand-scoped game queries (derived host_user_id → users.brand_id)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  function seed() {
    // Brand owner + an approved brand.
    const owner = createUser({ display_name: 'Owner', firebase_uid: 'uid_owner', email: 'owner@example.com' });
    const brand = createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id, status: 'approved' });
    // Two members tagged to the brand, one user with no brand.
    const memberA = createUser({ display_name: 'A', firebase_uid: 'uid_a', email: 'a@example.com', brand_id: brand.id });
    const memberB = createUser({ display_name: 'B', firebase_uid: 'uid_b', email: 'b@example.com', brand_id: brand.id });
    const outsider = createUser({ display_name: 'C', firebase_uid: 'uid_c', email: 'c@example.com' });
    return { brand, memberA, memberB, outsider };
  }

  it('getRecentGames returns only games hosted by a brand member', () => {
    const { brand, memberA, memberB, outsider } = seed();
    saveGameResult(hostedGame('g1', memberA.id, 'Alice'));
    saveGameResult(hostedGame('g2', outsider.id, 'Carol'));
    saveGameResult(hostedGame('g3', memberB.id, 'Bob'));
    saveGameResult(hostedGame('g4', undefined, 'Legacy')); // null host → never a brand game

    const result = getRecentGames({ brandId: brand.id });

    expect(result.total).toBe(2);
    expect(result.games.map((g) => g.id).sort()).toEqual(['g1', 'g3']);
  });

  it('getGamesStats counts only the brand-scoped games and their players', () => {
    const { brand, memberA, outsider } = seed();
    saveGameResult(hostedGame('g1', memberA.id, 'Alice')); // 3 players
    saveGameResult(hostedGame('g2', memberA.id, 'Alice2')); // 3 players
    saveGameResult(hostedGame('g3', outsider.id, 'Carol')); // excluded

    const scoped = getGamesStats({ brandId: brand.id });
    expect(scoped.totalGames).toBe(2);
    expect(scoped.finishedGames).toBe(2);
    expect(scoped.allPlayers).toBe(6);

    // Sanity: unscoped sees all three.
    expect(getGamesStats({}).totalGames).toBe(3);
  });

  it('returns nothing for a brand with no member-hosted games', () => {
    const { outsider } = seed();
    const otherOwner = createUser({ display_name: 'O2', firebase_uid: 'uid_o2', email: 'o2@example.com' });
    const emptyBrand = createBrand({ slug: 'empty', name: 'Empty', owner_user_id: otherOwner.id, status: 'approved' });
    saveGameResult(hostedGame('g1', outsider.id, 'Carol'));

    expect(getRecentGames({ brandId: emptyBrand.id }).total).toBe(0);
    expect(getGamesStats({ brandId: emptyBrand.id }).totalGames).toBe(0);
  });

  it('does not filter by brand when brandId is omitted', () => {
    const { memberA, outsider } = seed();
    saveGameResult(hostedGame('g1', memberA.id, 'Alice'));
    saveGameResult(hostedGame('g2', outsider.id, 'Carol'));

    expect(getRecentGames({}).total).toBe(2);
  });
});
