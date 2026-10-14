import {
  sanitizeVideoCall,
  sanitizeLink,
  sanitizePhone,
  sanitizeCode,
  sanitizeNotes,
  MAX_ENTRIES,
} from './videoCall.js';

describe('sanitizeLink', () => {
  it('accepts http and https', () => {
    expect(sanitizeLink('https://zoom.us/j/8123456789')).toBe('https://zoom.us/j/8123456789');
    expect(sanitizeLink('http://meet.jit.si/carked')).toBe('http://meet.jit.si/carked');
  });

  it('rejects script-bearing and non-web schemes', () => {
    expect(sanitizeLink('javascript:alert(1)')).toBeNull();
    expect(sanitizeLink('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(sanitizeLink('file:///etc/passwd')).toBeNull();
  });

  it('rejects unparseable and oversized values', () => {
    expect(sanitizeLink('not a url')).toBeNull();
    expect(sanitizeLink('')).toBeNull();
    expect(sanitizeLink(`https://zoom.us/j/${'9'.repeat(600)}`)).toBeNull();
    expect(sanitizeLink(42)).toBeNull();
  });
});

describe('sanitizePhone', () => {
  it('keeps dial characters including DTMF extensions', () => {
    expect(sanitizePhone('+61 2 8015 6011,,86123456789#'))
      .toBe('+61 2 8015 6011,,86123456789#');
    expect(sanitizePhone('(02) 8015-6011')).toBe('(02) 8015-6011');
  });

  it('strips anything that is not a dial character', () => {
    expect(sanitizePhone('+61 2 8015 6011 <script>')).toBe('+61 2 8015 6011');
  });

  it('rejects values with too few digits', () => {
    expect(sanitizePhone('12345')).toBeNull();
    expect(sanitizePhone('ext 4')).toBeNull();
  });
});

describe('sanitizeCode', () => {
  it('keeps alphanumeric codes with spaces and hyphens', () => {
    expect(sanitizeCode('812 3456 7890')).toBe('812 3456 7890');
    expect(sanitizeCode('carked-it')).toBe('carked-it');
  });

  it('strips markup', () => {
    expect(sanitizeCode('<b>4821</b>')).toBe('b4821b');
  });
});

describe('sanitizeNotes', () => {
  it('trims, normalises line endings and caps length', () => {
    expect(sanitizeNotes('  hi\r\n\n\n\nthere  ')).toBe('hi\n\nthere');
    expect(sanitizeNotes('x'.repeat(2000))).toHaveLength(1000);
  });

  it('leaves markup as inert text for the client to escape', () => {
    expect(sanitizeNotes('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });

  it('defaults to empty for non-strings', () => {
    expect(sanitizeNotes(undefined)).toBe('');
    expect(sanitizeNotes({})).toBe('');
  });
});

describe('sanitizeVideoCall', () => {
  it('keeps valid entries and drops invalid ones without failing the update', () => {
    const { entries, notes } = sanitizeVideoCall({
      entries: [
        { kind: 'link', platform: 'zoom', value: 'https://zoom.us/j/812', label: 'Join Zoom' },
        { kind: 'link', platform: 'zoom', value: 'javascript:alert(1)', label: 'Bad' },
        { kind: 'phone', value: '+61 2 8015 6011', label: 'Dial-in (AU)' },
        { kind: 'code', platform: 'zoom', value: '812 3456 7890', label: 'Meeting ID' },
        { kind: 'nonsense', value: 'x' },
        null,
      ],
      notes: 'Camera on please',
    });

    expect(entries).toEqual([
      { kind: 'link', platform: 'zoom', value: 'https://zoom.us/j/812', label: 'Join Zoom' },
      { kind: 'phone', platform: 'phone', value: '+61 2 8015 6011', label: 'Dial-in (AU)' },
      { kind: 'code', platform: 'zoom', value: '812 3456 7890', label: 'Meeting ID' },
    ]);
    expect(notes).toBe('Camera on please');
  });

  it('coerces unknown platforms to "other"', () => {
    const { entries } = sanitizeVideoCall({
      entries: [{ kind: 'link', platform: 'evil-corp', value: 'https://example.com/room' }],
    });
    expect(entries[0].platform).toBe('other');
  });

  it('forces phone entries onto the phone platform', () => {
    const { entries } = sanitizeVideoCall({
      entries: [{ kind: 'phone', platform: 'zoom', value: '+61280156011' }],
    });
    expect(entries[0].platform).toBe('phone');
  });

  it('caps the number of entries', () => {
    const { entries } = sanitizeVideoCall({
      entries: Array.from({ length: 20 }, (_, i) => ({
        kind: 'link', platform: 'other', value: `https://example.com/${i}`,
      })),
    });
    expect(entries).toHaveLength(MAX_ENTRIES);
  });

  it('truncates labels and tolerates a missing payload', () => {
    const { entries } = sanitizeVideoCall({
      entries: [{ kind: 'link', value: 'https://example.com/x', label: 'L'.repeat(200) }],
    });
    expect(entries[0].label).toHaveLength(60);
    expect(sanitizeVideoCall(undefined)).toEqual({ entries: [], notes: '' });
    expect(sanitizeVideoCall({ entries: 'nope' })).toEqual({ entries: [], notes: '' });
  });
});
