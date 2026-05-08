import {
  validateRequiredString,
  validateOptionalString,
  validateEnum,
  coerceWinner,
} from './validation.js';

describe('validateRequiredString', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['object', {}],
    ['empty string', ''],
    ['whitespace-only', '   '],
  ])('rejects %s', (_label, input) => {
    const result = validateRequiredString(input, 'display_name');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('display_name');
  });

  it('accepts a non-empty string', () => {
    expect(validateRequiredString('hi', 'display_name')).toEqual({
      ok: true,
      value: 'hi',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(validateRequiredString('  hi  ', 'display_name')).toEqual({
      ok: true,
      value: 'hi',
    });
  });
});

describe('validateOptionalString', () => {
  it('accepts undefined as "no change"', () => {
    expect(validateOptionalString(undefined, 'display_name')).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it.each([
    ['null', null],
    ['number', 42],
    ['object', { foo: 'bar' }],
  ])('rejects %s', (_label, input) => {
    const result = validateOptionalString(input, 'display_name');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('display_name');
  });

  it.each([
    ['empty string', ''],
    ['whitespace-only', '   '],
  ])('rejects %s', (_label, input) => {
    const result = validateOptionalString(input, 'display_name');
    expect(result.ok).toBe(false);
  });

  it('accepts a non-empty string', () => {
    expect(validateOptionalString('Brennan', 'display_name')).toEqual({
      ok: true,
      value: 'Brennan',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(validateOptionalString('  Brennan  ', 'display_name')).toEqual({
      ok: true,
      value: 'Brennan',
    });
  });
});

describe('validateEnum', () => {
  const STATUSES = ['draft', 'published'] as const;

  it('accepts undefined as "no change"', () => {
    expect(validateEnum(undefined, 'status', STATUSES)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it.each([
    ['empty string', ''],
    ['archived', 'archived'],
    ['number', 42],
    ['null', null],
  ])('rejects %s', (_label, input) => {
    const result = validateEnum(input, 'status', STATUSES);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('status');
      expect(result.error).toContain('draft');
    }
  });

  it.each(STATUSES)('accepts %s', (input) => {
    expect(validateEnum(input, 'status', STATUSES)).toEqual({
      ok: true,
      value: input,
    });
  });
});

describe('coerceWinner', () => {
  it('returns Unknown/0 for an empty array', () => {
    expect(coerceWinner([])).toEqual({
      winner_name: 'Unknown',
      winner_score: 0,
    });
  });

  it('defaults score to 0 when missing', () => {
    expect(coerceWinner([{ name: 'Alice' }])).toEqual({
      winner_name: 'Alice',
      winner_score: 0,
    });
  });

  it('defaults score to 0 when not a number', () => {
    expect(coerceWinner([{ name: 'Alice', score: '42' }])).toEqual({
      winner_name: 'Alice',
      winner_score: 0,
    });
  });

  it('defaults score to 0 for non-finite numbers', () => {
    expect(coerceWinner([{ name: 'Alice', score: NaN }])).toEqual({
      winner_name: 'Alice',
      winner_score: 0,
    });
  });

  it('defaults name to Unknown when missing', () => {
    expect(coerceWinner([{ score: 5 }])).toEqual({
      winner_name: 'Unknown',
      winner_score: 5,
    });
  });

  it('defaults name to Unknown when empty string', () => {
    expect(coerceWinner([{ name: '', score: 5 }])).toEqual({
      winner_name: 'Unknown',
      winner_score: 5,
    });
  });

  it('returns supplied values on the happy path', () => {
    expect(coerceWinner([{ name: 'Alice', score: 7 }])).toEqual({
      winner_name: 'Alice',
      winner_score: 7,
    });
  });
});
