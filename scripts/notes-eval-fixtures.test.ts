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
import { parseWindowSpec, staleClockWarning } from './notes-eval-fixtures.ts';

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

/**
 * A fixture records how the live pipeline WOULD have grouped the speech, and
 * takes that grouping from `pause-ticker.ts` at build time. So when the cadence
 * ceiling went 15s -> 6s in PR 872, every fixture on disk kept the old cut and
 * went on reporting an eval of a system that no longer ships — the same hour of
 * EN2001a is 173 ticks at 15s and 306 at 6s. Nothing said so, which is the part
 * these cases fix.
 */
describe('staleClockWarning', () => {
  const cut = { quietMs: 4_000, cadenceMs: 6_000 };

  it('says nothing when the fixture was cut with the clocks that ship', () => {
    expect(staleClockWarning({ meeting: 'EN2001a', clocks: cut }, 4_000, 6_000)).toBeNull();
  });

  it('names both clocks when the cadence has moved under the fixture', () => {
    const said = staleClockWarning(
      { meeting: 'EN2001a', clocks: { ...cut, cadenceMs: 15_000 } },
      4_000,
      6_000,
    );
    expect(said).toContain('EN2001a');
    expect(said).toContain('15000');
    expect(said).toContain('6000');
  });

  it('names a moved quiet threshold too, not only the cadence', () => {
    expect(
      staleClockWarning({ meeting: 'EN2001a', clocks: { ...cut, quietMs: 9_000 } }, 4_000, 6_000),
    ).toContain('9000');
  });

  // The eight committed fixtures carry no clocks: they predate the stamp. A
  // line about them on every CI smoke run would be a nag about work this
  // function is not doing, and a warning that fires always is one nobody reads.
  it('says nothing about a fixture that predates the stamp', () => {
    expect(staleClockWarning({ meeting: 'ES2002a' }, 4_000, 6_000)).toBeNull();
  });
});
