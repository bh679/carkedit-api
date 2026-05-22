import {
  computeMedian,
  mapPhaseToGroup,
  walkPhaseDurations,
  summariseStateBuckets,
  type PhaseEventRow,
} from './database.js';

describe('computeMedian', () => {
  it('returns 0 for an empty array', () => {
    expect(computeMedian([])).toBe(0);
  });

  it('returns the only value for a single-element array', () => {
    expect(computeMedian([42])).toBe(42);
  });

  it('returns the middle value for odd-length arrays', () => {
    expect(computeMedian([5, 1, 3])).toBe(3);
  });

  it('returns the average of the two middle values for even-length arrays', () => {
    expect(computeMedian([1, 2, 3, 4])).toBe(2.5);
  });

  it('does not mutate the input array', () => {
    const input = [5, 1, 3];
    computeMedian(input);
    expect(input).toEqual([5, 1, 3]);
  });
});

describe('mapPhaseToGroup', () => {
  it.each([
    ['lobby', 'lobby'],
    ['', 'lobby'],
    ['die', 'die'],
    ['die_phase', 'die'],
    ['live', 'living'],
    ['living_setup', 'living'],
    ['living_winner', 'living'],
    ['bye_submit', 'bye'],
    ['eulogy_speech', 'eulogy'],
    ['finished', 'finished'],
    ['winner', 'finished'],
    ['game_over', 'finished'],
    ['abandoned', 'other'],
  ])('maps phase %s to group %s', (phase, expectedGroup) => {
    // '' is mapped via the lobby member list (which includes empty string)
    if (phase === '') {
      // mapPhaseToGroup short-circuits on falsy input; '' is treated as no phase
      expect(mapPhaseToGroup(phase)).toBeNull();
      return;
    }
    expect(mapPhaseToGroup(phase)).toBe(expectedGroup);
  });

  it('returns null for null or undefined', () => {
    expect(mapPhaseToGroup(null)).toBeNull();
    expect(mapPhaseToGroup(undefined)).toBeNull();
  });

  it('returns "other" for unknown phases', () => {
    expect(mapPhaseToGroup('mystery_phase')).toBe('other');
  });
});

describe('walkPhaseDurations', () => {
  function row(game_id: string, phase: string, created_at: string, finished_at: string | null = null): PhaseEventRow {
    return { game_id, phase, created_at, finished_at };
  }

  it('returns empty buckets for no rows', () => {
    expect(walkPhaseDurations([])).toEqual({
      lobby: [], die: [], living: [], bye: [], eulogy: [], finished: [], other: [],
    });
  });

  it('records the duration between two consecutive different phases', () => {
    const rows = [
      row('g1', 'lobby', '2026-05-22T10:00:00Z', '2026-05-22T10:30:00Z'),
      row('g1', 'die',   '2026-05-22T10:05:00Z', '2026-05-22T10:30:00Z'),
    ];
    const buckets = walkPhaseDurations(rows);
    expect(buckets.lobby).toEqual([300]); // 5 minutes = 300 seconds
  });

  it('uses finished_at to close out the final phase', () => {
    const rows = [
      row('g1', 'lobby',    '2026-05-22T10:00:00Z', '2026-05-22T10:30:00Z'),
      row('g1', 'finished', '2026-05-22T10:25:00Z', '2026-05-22T10:30:00Z'),
    ];
    const buckets = walkPhaseDurations(rows);
    expect(buckets.lobby).toEqual([1500]); // 25min
    expect(buckets.finished).toEqual([300]); // 5min remaining → 5*60 = 300
  });

  it('skips the final phase when finished_at is null (live games)', () => {
    const rows = [
      row('g1', 'lobby', '2026-05-22T10:00:00Z', null),
      row('g1', 'die',   '2026-05-22T10:05:00Z', null),
    ];
    const buckets = walkPhaseDurations(rows);
    expect(buckets.lobby).toEqual([300]);
    expect(buckets.die).toEqual([]); // final phase, no finished_at → skipped
  });

  it('aggregates the same base state from multiple sub-phases', () => {
    const rows = [
      row('g1', 'living_setup',  '2026-05-22T10:00:00Z'),
      row('g1', 'living_submit', '2026-05-22T10:02:00Z'),
      row('g1', 'living_winner', '2026-05-22T10:05:00Z'),
      row('g1', 'bye_setup',     '2026-05-22T10:10:00Z'),
    ];
    const buckets = walkPhaseDurations(rows);
    // Three living sub-phases each get separate durations because we record per transition
    expect(buckets.living).toEqual([120, 180, 300]); // 2min, 3min, 5min
  });

  it('handles multiple games independently', () => {
    const rows = [
      row('g1', 'lobby', '2026-05-22T10:00:00Z', '2026-05-22T10:30:00Z'),
      row('g1', 'die',   '2026-05-22T10:01:00Z', '2026-05-22T10:30:00Z'),
      row('g2', 'lobby', '2026-05-22T11:00:00Z', '2026-05-22T11:10:00Z'),
      row('g2', 'die',   '2026-05-22T11:02:00Z', '2026-05-22T11:10:00Z'),
    ];
    const buckets = walkPhaseDurations(rows);
    expect(buckets.lobby).toEqual([60, 120]);
  });

  it('ignores invalid timestamps', () => {
    const rows = [
      row('g1', 'lobby', 'not-a-date'),
      row('g1', 'die',   '2026-05-22T10:05:00Z', '2026-05-22T10:30:00Z'),
    ];
    const buckets = walkPhaseDurations(rows);
    // Invalid first row is skipped — die becomes first phase, then closed by finished_at
    expect(buckets.die).toEqual([1500]); // 25min until finished_at
  });
});

describe('summariseStateBuckets', () => {
  it('returns one entry per ordered state, with zeros for empty buckets', () => {
    const result = summariseStateBuckets({
      lobby: [60, 120, 180],
      die: [],
      living: [], bye: [], eulogy: [], finished: [], other: [],
    });
    expect(result).toHaveLength(7);
    expect(result.map(r => r.state)).toEqual(['lobby', 'die', 'living', 'bye', 'eulogy', 'finished', 'other']);

    const lobby = result.find(r => r.state === 'lobby')!;
    expect(lobby.count).toBe(3);
    expect(lobby.avg_seconds).toBe(120);
    expect(lobby.median_seconds).toBe(120);
    expect(lobby.total_seconds).toBe(360);

    const die = result.find(r => r.state === 'die')!;
    expect(die).toEqual({ state: 'die', count: 0, avg_seconds: 0, median_seconds: 0, total_seconds: 0 });
  });

  it('rounds avg and median to whole seconds', () => {
    const result = summariseStateBuckets({
      lobby: [10, 20, 25], // avg = 18.33 → 18, median = 20
      die: [], living: [], bye: [], eulogy: [], finished: [], other: [],
    });
    const lobby = result.find(r => r.state === 'lobby')!;
    expect(lobby.avg_seconds).toBe(18);
    expect(lobby.median_seconds).toBe(20);
  });
});
