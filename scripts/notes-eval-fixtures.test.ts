import { describe, expect, it } from 'vitest';
/**
 * The window argument that lets the fixture builder cut a meeting the eight
 * committed fixtures do not cover.
 *
 * Those eight are fifteen-minute windows, so "do the notes still keep up at
 * the end of an hour" cannot be asked of any of them. `EN2001a:120:3600` cuts
 * an hour of real speech out of a real recording instead. The parse is what
 * decides whether an argument is such a window or a plain meeting name, and
 * getting that wrong silently rebuilds the wrong fixture — so it is checked
 * here rather than left to the one caller.
 */
import { parseWindowSpec } from './notes-eval-fixtures.ts';

describe('parseWindowSpec', () => {
  it('reads the meeting, the start and the length out of a window argument', () => {
    expect(parseWindowSpec('EN2001a:120:3600')).toEqual({
      meeting: 'EN2001a',
      fromSeconds: 120,
      seconds: 3600,
    });
  });

  it('starts at zero when the window says so', () => {
    expect(parseWindowSpec('EN2009d:0:60')).toEqual({
      meeting: 'EN2009d',
      fromSeconds: 0,
      seconds: 60,
    });
  });

  it('declines a bare meeting name, so the old form still means a meeting', () => {
    expect(parseWindowSpec('ES2002a')).toBeNull();
  });

  it('declines an argument missing a field, rather than guessing the length', () => {
    expect(parseWindowSpec('EN2001a:120')).toBeNull();
  });

  it('declines a non-numeric window, rather than reading it as NaN seconds', () => {
    expect(parseWindowSpec('EN2001a:two:3600')).toBeNull();
  });
});
