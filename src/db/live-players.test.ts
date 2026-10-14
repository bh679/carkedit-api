import {
  initDatabase,
  createLiveGame,
  syncLivePlayers,
  completeLiveGame,
  getUserGameStats,
  getGameById,
} from './database.js';

// Player/users stats aggregate game_players, which was historically written
// only at completion — so in-progress games showed no players. syncLivePlayers
// snapshots the live roster so active games appear too.
describe('live-game player snapshot (game_players for in-progress games)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  function startLive(id: string) {
    return createLiveGame({ id, started_at: '2026-06-26T00:00:00.000Z', mode: 'online', player_count: 0, is_dev: false });
  }

  it('a LIVE game contributes NO players until the roster is snapshotted', () => {
    startLive('g1');
    expect(getUserGameStats({ devFilter: 'all' }).total_distinct).toBe(0);
  });

  it('syncLivePlayers makes a live game appear in player stats', () => {
    startLive('g1');
    syncLivePlayers('g1', ['Alice', 'Bob']);
    const stats = getUserGameStats({ devFilter: 'all' });
    expect(stats.total_distinct).toBe(2);
    expect(stats.players.map((p) => p.display_name).sort()).toEqual(['Alice', 'Bob']);
    expect(stats.players.find((p) => p.display_name === 'Alice')?.games_played).toBe(1);
  });

  it('re-syncing replaces the roster (idempotent — Bob leaves, Carol joins)', () => {
    startLive('g1');
    syncLivePlayers('g1', ['Alice', 'Bob']);
    syncLivePlayers('g1', ['Alice', 'Carol']);
    expect(getUserGameStats({ devFilter: 'all' }).players.map((p) => p.display_name).sort()).toEqual(['Alice', 'Carol']);
    expect(getGameById('g1')?.players.length).toBe(2);
  });

  it('completeLiveGame replaces the live snapshot with final results (no dupes)', () => {
    startLive('g1');
    syncLivePlayers('g1', ['Alice', 'Bob']);
    completeLiveGame('g1', {
      finished_at: '2026-06-26T00:10:00.000Z', rounds: 1, player_count: 2,
      winner_name: 'Alice', winner_score: 5, duration_seconds: 600,
      has_error: false, is_dev: false,
      players: [
        { player_name: 'Alice', score: 5, rank: 1 },
        { player_name: 'Bob', score: 3, rank: 2 },
      ],
    });
    const game = getGameById('g1');
    expect(game?.players.length).toBe(2);                                            // not 4
    expect(game?.players.find((p) => p.player_name === 'Alice')?.score).toBe(5);     // final score, not the 0 placeholder
    expect(getUserGameStats({ devFilter: 'all' }).total_distinct).toBe(2);
  });
});
