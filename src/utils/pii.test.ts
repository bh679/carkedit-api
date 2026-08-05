import {
  maskName,
  redactGameList,
  redactGameDetail,
  redactUserStats,
  redactSurveyResponses,
  redactGameEvents,
  redactIssueReports,
  redactBrandUsers,
  opaqueKey,
  isOpaqueKey,
  resolveOpaqueKey,
} from './pii.js';

// Minimal fixtures — only the fields the redactors touch, cast at the call site.
const gameSummary = {
  id: 'g1',
  host_name: 'Brennan',
  winner_name: 'Alice',
  players: [
    { player_name: 'Alice', score: 3, rank: 1 },
    { player_name: 'Bob', score: 1, rank: 2 },
  ],
  player_count: 2,
} as any;

describe('maskName', () => {
  it.each([
    ['Alice', 'A****'],
    ['Bo', 'B*'],
    ['X', '*'],
    ['', '*'],
    [null, '*'],
    [undefined, '*'],
  ])('masks %p as %p', (input, expected) => {
    expect(maskName(input as any)).toBe(expected);
  });

  it('matches the algorithm the client used to apply (first char + one star per remaining)', () => {
    const legacy = (name: string) => (!name || name.length <= 1 ? '*' : name[0] + '*'.repeat(name.length - 1));
    for (const n of ['Brennan', 'Jo', 'a', 'Anne-Marie', '🎲player']) {
      expect(maskName(n)).toBe(legacy(n));
    }
  });
});

describe('reveal = true passes payloads through untouched', () => {
  it('returns the exact same object reference for every redactor', () => {
    const list = { games: [gameSummary], total: 1 } as any;
    const users = { players: [{ name_key: 'alice', display_name: 'Alice', email: 'a@b.com' }] } as any;
    const surveys = { responses: [{ player_name: 'Alice' }], total: 1 } as any;
    const events = [{ actor_name: 'Alice', data_json: '{"who":"Alice"}' }] as any;
    const issues = { reports: [{ id: 'i1', players_json: '["Alice"]' }], total: 1 } as any;

    expect(redactGameList(list, true)).toBe(list);
    expect(redactGameDetail(gameSummary, true)).toBe(gameSummary);
    expect(redactUserStats(users, true)).toBe(users);
    expect(redactSurveyResponses(surveys, true)).toBe(surveys);
    expect(redactGameEvents(events, true)).toBe(events);
    expect(redactIssueReports(issues, true)).toBe(issues);
  });
});

describe('redactGameList', () => {
  it('masks host, winner and every player name', () => {
    const out = redactGameList({ games: [gameSummary], total: 1 } as any, false);
    expect(out.games[0].host_name).toBe('B******');
    expect(out.games[0].winner_name).toBe('A****');
    expect(out.games[0].players.map((p: any) => p.player_name)).toEqual(['A****', 'B**']);
  });

  it('preserves a null host_name instead of turning it into "*"', () => {
    const out = redactGameList({ games: [{ ...gameSummary, host_name: null }], total: 1 } as any, false);
    expect(out.games[0].host_name).toBeNull();
  });

  it('does not mutate the source row', () => {
    const source = { games: [{ ...gameSummary }], total: 1 } as any;
    redactGameList(source, false);
    expect(source.games[0].host_name).toBe('Brennan');
    expect(source.games[0].players[0].player_name).toBe('Alice');
  });

  it('leaves non-name fields alone', () => {
    const out = redactGameList({ games: [gameSummary], total: 1 } as any, false);
    expect(out.games[0].id).toBe('g1');
    expect(out.games[0].player_count).toBe(2);
    expect(out.total).toBe(1);
  });
});

describe('redactGameDetail', () => {
  const detail = {
    ...gameSummary,
    settings_json: '{"rounds":3}',
    card_plays: [{ card_id: 'c1', player_name: 'Alice', is_winner: 1 }],
    issues: [{ id: 'i1', category: 'bug', players_json: '["Alice","Bob"]', game_state_json: '{"turn":"Alice"}' }],
  } as any;

  it('masks card play player names', () => {
    const out = redactGameDetail(detail, false);
    expect(out.card_plays[0].player_name).toBe('A****');
    expect(out.card_plays[0].card_id).toBe('c1');
  });

  it('drops the debug blobs that embed names', () => {
    const out = redactGameDetail(detail, false);
    expect(out.issues[0]).not.toHaveProperty('players_json');
    expect(out.issues[0]).not.toHaveProperty('game_state_json');
    expect(out.issues[0].category).toBe('bug');
  });

  it('keeps settings_json and the summary fields', () => {
    const out = redactGameDetail(detail, false);
    expect(out.settings_json).toBe('{"rounds":3}');
    expect(out.host_name).toBe('B******');
  });

  it('tolerates a detail row with no issues or card plays', () => {
    const out = redactGameDetail({ ...gameSummary } as any, false);
    expect(out.card_plays).toEqual([]);
    expect(out.issues).toEqual([]);
  });
});

describe('redactUserStats', () => {
  const stats = {
    players: [{
      name_key: 'alice',
      display_name: 'Alice',
      email: 'alice@example.com',
      avatar_url: 'https://lh3.googleusercontent.com/a/abc',
      games_played: 4,
      matched_user_id: 'usr_1',
    }],
    total_distinct: 1,
    total_matched_users: 1,
  } as any;

  it('masks the display name', () => {
    expect(redactUserStats(stats, false).players[0].display_name).toBe('A****');
  });

  it('drops email and avatar entirely rather than masking them', () => {
    const out = redactUserStats(stats, false);
    expect(out.players[0].email).toBeNull();
    expect(out.players[0].avatar_url).toBeNull();
  });

  it('replaces name_key with an opaque, non-reversible key', () => {
    const key = redactUserStats(stats, false).players[0].name_key;
    expect(key).not.toBe('alice');
    expect(key).not.toContain('alice');
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the opaque key stable across calls so client row identity survives', () => {
    const a = redactUserStats(stats, false).players[0].name_key;
    const b = redactUserStats(stats, false).players[0].name_key;
    expect(a).toBe(b);
  });

  it('gives different names different keys', () => {
    const two = redactUserStats({ ...stats, players: [
      { ...stats.players[0], name_key: 'alice' },
      { ...stats.players[0], name_key: 'bob' },
    ] } as any, false);
    expect(two.players[0].name_key).not.toBe(two.players[1].name_key);
  });

  it('preserves the aggregate counts', () => {
    const out = redactUserStats(stats, false);
    expect(out.total_distinct).toBe(1);
    expect(out.players[0].games_played).toBe(4);
  });
});

describe('redactSurveyResponses', () => {
  it('masks respondent names but keeps scores and comments', () => {
    const out = redactSurveyResponses({
      responses: [{ id: 's1', player_name: 'Alice', nps_score: 9, comment: 'great' }],
      total: 1,
    } as any, false);
    expect(out.responses[0].player_name).toBe('A****');
    expect(out.responses[0].nps_score).toBe(9);
    expect(out.responses[0].comment).toBe('great');
  });

  it('leaves an absent player_name absent (anonymous responses)', () => {
    const out = redactSurveyResponses({ responses: [{ id: 's1' }], total: 1 } as any, false);
    expect(out.responses[0].player_name).toBeUndefined();
  });
});

describe('redactGameEvents', () => {
  it('masks actor_name and drops the free-form payload', () => {
    const out = redactGameEvents([
      { id: 1, actor_name: 'Alice', event_type: 'play', data_json: '{"player":"Alice"}' },
    ] as any, false);
    expect(out[0].actor_name).toBe('A****');
    expect(out[0].data_json).toBeNull();
    expect(out[0].event_type).toBe('play');
  });

  it('preserves a null actor_name', () => {
    const out = redactGameEvents([{ id: 1, actor_name: null }] as any, false);
    expect(out[0].actor_name).toBeNull();
  });
});

describe('opaque key round-trip', () => {
  it('recognises its own keys and rejects raw names', () => {
    expect(isOpaqueKey(opaqueKey('alice'))).toBe(true);
    expect(isOpaqueKey('alice')).toBe(false);
    expect(isOpaqueKey('')).toBe(false);
    expect(isOpaqueKey('ALICE0123456789A')).toBe(false); // 16 chars, not hex
  });

  it('resolves a key back to the matching name key', () => {
    const key = opaqueKey('alice');
    expect(resolveOpaqueKey(key, ['bob', 'alice', 'carol'])).toBe('alice');
  });

  it('returns null when no candidate matches', () => {
    expect(resolveOpaqueKey(opaqueKey('dave'), ['bob', 'alice'])).toBeNull();
    expect(resolveOpaqueKey('deadbeefdeadbeef', [])).toBeNull();
  });

  it('resolves the key the Users table actually hands the client', () => {
    // End-to-end of the expand flow: redact a row, then use its key to look the
    // player back up the way GET /games?playerName=<key> does.
    const redacted = redactUserStats({ players: [{ name_key: 'alice', display_name: 'Alice' }] } as any, false);
    expect(resolveOpaqueKey(redacted.players[0].name_key, ['alice', 'bob'])).toBe('alice');
  });
});

describe('redactBrandUsers', () => {
  it('masks display names in a brand signup list', () => {
    const out = redactBrandUsers([{ id: 'u1', display_name: 'Alice', created_at: 'x' }] as any[], false) as any[];
    expect(out[0].display_name).toBe('A****');
    expect(out[0].id).toBe('u1');
  });

  it('returns the list untouched for an Admin', () => {
    const list = [{ id: 'u1', display_name: 'Alice' }] as any;
    expect(redactBrandUsers(list, true)).toBe(list);
  });
});
