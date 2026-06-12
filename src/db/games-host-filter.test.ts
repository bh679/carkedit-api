import { initDatabase, saveGameResult, getRecentGames } from './database.js';
import type { GameResult } from './types.js';

// Builds a minimal finished game hosted by `hostUserId` (undefined = legacy game
// with no owner). Used to exercise the account-scoped "My Games" filter.
function hostedGame(id: string, hostUserId: string | undefined, winnerName: string): GameResult {
  return {
    id,
    finished_at: '2026-06-01T00:00:00.000Z',
    mode: 'online',
    rounds: 1,
    player_count: 1,
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

describe('getRecentGames — hostUserId filter (account-scoped "My Games")', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  it('returns only games hosted by the given user', () => {
    saveGameResult(hostedGame('g1', 'userA', 'Alice'));
    saveGameResult(hostedGame('g2', 'userB', 'Bob'));
    saveGameResult(hostedGame('g3', 'userA', 'Alice2'));

    const result = getRecentGames({ hostUserId: 'userA' });

    expect(result.total).toBe(2);
    expect(result.games.map((g) => g.id).sort()).toEqual(['g1', 'g3']);
  });

  it('returns no games for a brand-new account that has hosted none', () => {
    saveGameResult(hostedGame('g1', 'userA', 'Alice'));

    const result = getRecentGames({ hostUserId: 'brand-new-user' });

    expect(result.total).toBe(0);
    expect(result.games).toEqual([]);
  });

  it('does not filter by host when hostUserId is omitted', () => {
    saveGameResult(hostedGame('g1', 'userA', 'Alice'));
    saveGameResult(hostedGame('g2', 'userB', 'Bob'));

    expect(getRecentGames({}).total).toBe(2);
  });

  it('excludes legacy games that have a null host_user_id', () => {
    saveGameResult(hostedGame('g1', 'userA', 'Alice'));
    saveGameResult(hostedGame('g2', undefined, 'Legacy'));

    expect(getRecentGames({ hostUserId: 'userA' }).games.map((g) => g.id)).toEqual(['g1']);
  });
});
