import {
  initDatabase,
  saveGameResult,
  saveCardPlays,
  saveCardDraws,
  saveSurveyResponse,
  getCardStats,
  getSurveyStats,
  getSurveyResponses,
  getUserGameStats,
} from './database.js';
import { createUser } from './users.js';
import { createBrand, listBrandUsers } from './brands.js';
import { createPack, listPackStatsAll } from './packs.js';
import type { GameResult } from './types.js';

// Every brand-scoped viewer derives its brand the SAME way games do:
// the row → its game → games.host_user_id → users.brand_id. These tests assert
// each aggregation function counts ONLY brand-hosted activity when given brandId.
function hostedGame(id: string, hostUserId: string, winner: string): GameResult {
  return {
    id,
    finished_at: '2026-06-20T00:00:00.000Z',
    mode: 'online',
    rounds: 1,
    player_count: 1,
    winner_name: winner,
    winner_score: 5,
    status: 'finished',
    live_status: 'completed',
    has_error: false,
    is_dev: false,
    host_user_id: hostUserId,
    players: [{ player_name: winner, score: 5, rank: 1 }],
  };
}

const sumPlays = (r: { cards: { play_count: number }[] }) => r.cards.reduce((n, c) => n + c.play_count, 0);
const sumDraws = (r: { cards: { draw_count: number }[] }) => r.cards.reduce((n, c) => n + c.draw_count, 0);

describe('brand-scoped stats viewers (derived host_user_id → users.brand_id)', () => {
  let brandId: string;
  let member: { id: string };
  let outsider: { id: string };

  beforeEach(() => {
    initDatabase(':memory:');
    const owner = createUser({ display_name: 'Owner', firebase_uid: 'uid_owner', email: 'owner@example.com' });
    const brand = createBrand({ slug: 'acme', name: 'Acme', owner_user_id: owner.id, status: 'approved' });
    brandId = brand.id;
    member = createUser({ display_name: 'Member', firebase_uid: 'uid_m', email: 'm@example.com', brand_id: brand.id });
    outsider = createUser({ display_name: 'Outsider', firebase_uid: 'uid_o', email: 'o@example.com' });

    // g1 hosted by a brand member; g2 hosted by an outsider.
    saveGameResult(hostedGame('g1', member.id, 'Alice'));
    saveGameResult(hostedGame('g2', outsider.id, 'Bob'));
  });

  it('getCardStats scopes card plays/draws to brand-hosted games', () => {
    saveCardPlays([
      { game_id: 'g1', round: 1, phase: 'die', card_id: 'c1', card_text: 'x', card_deck: 'die', player_name: 'Alice', is_winner: true },
      { game_id: 'g1', round: 1, phase: 'die', card_id: 'c2', card_text: 'y', card_deck: 'die', player_name: 'Alice', is_winner: false },
      { game_id: 'g2', round: 1, phase: 'die', card_id: 'c1', card_text: 'x', card_deck: 'die', player_name: 'Bob', is_winner: true },
    ]);
    saveCardDraws([
      { game_id: 'g1', phase: 'die', card_id: 'c1', card_deck: 'die' },
      { game_id: 'g2', phase: 'die', card_id: 'c1', card_deck: 'die' },
      { game_id: 'g2', phase: 'die', card_id: 'c2', card_deck: 'die' },
    ]);

    expect(sumPlays(getCardStats('all'))).toBe(3);          // all games
    expect(sumPlays(getCardStats('all', brandId))).toBe(2); // only g1
    expect(sumDraws(getCardStats('all'))).toBe(3);
    expect(sumDraws(getCardStats('all', brandId))).toBe(1); // only g1's draw
  });

  it('getSurveyStats / getSurveyResponses scope to brand-hosted games (NULL game excluded)', () => {
    saveSurveyResponse({ id: 's1', created_at: '2026-06-20T01:00:00.000Z', game_id: 'g1', nps_score: 9 });
    saveSurveyResponse({ id: 's2', created_at: '2026-06-20T02:00:00.000Z', game_id: 'g2', nps_score: 3 });
    saveSurveyResponse({ id: 's3', created_at: '2026-06-20T03:00:00.000Z', nps_score: 7 }); // no game → never brand

    expect(getSurveyStats('all').count).toBe(3);
    expect(getSurveyStats('all', brandId).count).toBe(1); // only s1 (g1)
    expect(getSurveyResponses(50, 0, 'all', brandId).responses.map((r) => r.id)).toEqual(['s1']);
    expect(getSurveyResponses(50, 0, 'all').total).toBe(3);
  });

  it('getUserGameStats scopes players to brand-hosted games', () => {
    expect(getUserGameStats({ devFilter: 'all' }).total_distinct).toBe(2);                 // Alice + Bob
    const scoped = getUserGameStats({ devFilter: 'all', brandId });
    expect(scoped.total_distinct).toBe(1);
    expect(scoped.players.map((p) => p.display_name)).toEqual(['Alice']);
  });

  it('listPackStatsAll exposes each pack creator brand_id (for the client "Brand packs" filter)', () => {
    const brandPack = createPack({ creator_id: member.id, title: 'Brand Pack' });
    const otherPack = createPack({ creator_id: outsider.id, title: 'Other Pack' });
    const rows = listPackStatsAll();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(brandPack.id)?.creator_brand_id).toBe(brandId);
    expect(byId.get(otherPack.id)?.creator_brand_id).toBeNull();
  });

  it('listBrandUsers still returns only brand-tagged accounts (sanity)', () => {
    expect(listBrandUsers(brandId).map((u) => u.id)).toEqual([member.id]);
  });
});
