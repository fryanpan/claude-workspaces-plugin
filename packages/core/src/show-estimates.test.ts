import { describe, expect, it } from 'vitest';
import { estimatesShown, parseShowEstimates } from './show-estimates.ts';

describe('estimatesShown', () => {
  it('is off for a board that never set it, and for anything but true', () => {
    expect(estimatesShown(null)).toBe(false);
    expect(estimatesShown(undefined)).toBe(false);
    expect(estimatesShown({})).toBe(false);
    expect(estimatesShown({ showEstimates: false })).toBe(false);
    expect(estimatesShown({ showEstimates: 'true' })).toBe(false);
    expect(estimatesShown({ showEstimates: 1 })).toBe(false);
  });

  it('is on only when the board says true', () => {
    expect(estimatesShown({ showEstimates: true })).toBe(true);
  });
});

describe('parseShowEstimates', () => {
  it('takes true and false, and reads null as the default, off', () => {
    expect(parseShowEstimates(true)).toEqual({ ok: true, value: true });
    expect(parseShowEstimates(false)).toEqual({ ok: true, value: false });
    expect(parseShowEstimates(null)).toEqual({ ok: true, value: false });
  });

  it('refuses everything else', () => {
    for (const raw of ['true', 1, 0, undefined, {}, []]) {
      expect(parseShowEstimates(raw).ok).toBe(false);
    }
  });
});
