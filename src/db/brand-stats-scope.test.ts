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

// Game/card/survey/player scope follows games.brand_id (PLAY attribution — the
// brand URL the game was created on); pack-creator + signups scope still follow
// users.brand_id. These tests assert each aggregation counts ONLY brand activity.
function hostedGame(id: string, hostUserId: string, winner: string, brandId?: string | null): GameResult {
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
    brand_id: brandId ?? null,
    players: [{ player_name: winner, score: 5, rank: 1 }],
  };
}

const sumPlays = (r: { cards: { play_count: number }[] }) => r.cards.reduce((n, c) => n + c.play_count, 0);
const sumDraws = (r: { cards: { draw_count: number }[] }) => r.cards.reduce((n, c) => n + c.draw_count, 0);

describe('brand-scoped stats viewers (games.brand_id play attribution)', () => {
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

    // g1 created on the brand URL (games.brand_id tagged); g2 untagged. Hosts
    // differ too, to prove brand scope follows the GAME tag, not the host.
    saveGameResult(hostedGame('g1', member.id, 'Alice', brand.id));
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

  it('getUserGameStats reports each matched player\'s SIGNUP brand (users.brand_id)', () => {
    // Players Alice (g1) and Bob (g2) get accounts: Alice signed up UNDER the
    // brand, Bob on root (no brand). The "signed up" column reads these.
    createUser({ display_name: 'Alice', firebase_uid: 'uid_alice', email: 'alice@example.com', brand_id: brandId });
    createUser({ display_name: 'Bob', firebase_uid: 'uid_bob', email: 'bob@example.com' });

    const players = getUserGameStats({ devFilter: 'all' }).players;
    const alice = players.find((p) => p.display_name === 'Alice');
    const bob = players.find((p) => p.display_name === 'Bob');

    expect(alice?.signup_brand_id).toBe(brandId);
    expect(alice?.signup_brand_name).toBe('Acme');   // → brand name in the column
    expect(bob?.matched_user_id).toBeTruthy();
    expect(bob?.signup_brand_id).toBeNull();          // → "Root" in the column
    expect(bob?.signup_brand_name).toBeNull();
  });

  it('includeAccounts folds in this brand\'s signups who never played (replaces the old section)', () => {
    // beforeEach: "Member" signed up under the brand but never played (only
    // Alice/Bob appear as players). g1 is Alice's brand-hosted game.
    const playersOnly = getUserGameStats({ devFilter: 'all', brandId }).players;
    expect(playersOnly.map((p) => p.display_name)).toEqual(['Alice']);   // signup-only Member absent

    const withAccts = getUserGameStats({ devFilter: 'all', brandId, includeAccounts: true });
    const names = withAccts.players.map((p) => p.display_name).sort();
    expect(names).toEqual(['Alice', 'Member']);                          // Member folded in
    const memberRow = withAccts.players.find((p) => p.display_name === 'Member');
    expect(memberRow?.games_played).toBe(0);                             // never played
    expect(memberRow?.matched_user_id).toBe(member.id);
    expect(memberRow?.signup_brand_id).toBe(brandId);                    // → filterable as "your brand"
    // Outsider (no brand) is NOT folded into a brand-scoped list.
    expect(names).not.toContain('Outsider');
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
