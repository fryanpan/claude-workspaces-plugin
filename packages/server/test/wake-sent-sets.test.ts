/**
 * The memory that stops a wake naming what its reader was already handed.
 *
 * Driven directly rather than through a nudger, because the two nudgers reach
 * it by different routes and the rules it enforces are its own: growth is
 * news, a shrink is not, a board is remembered per SESSION, and an entry that
 * falls off the findings for a whole window comes back as new.
 *
 * Fixtures are synthetic; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { WakeSentSets } from '../src/wake-sent-sets.ts';

const MIN = 60_000;
const WINDOW = 30 * MIN;
const WS = 'w-harbor';
const LEAD = 'agent-lead';

function sets(): WakeSentSets {
  return new WakeSentSets(WINDOW);
}

describe('what counts as a repeat', () => {
  it('is nothing at all before the first delivery', () => {
    const s = sets();

    expect(s.nothingNew(WS, LEAD, ['t-1'])).toBe(false);
  });

  it('is the same set said again', () => {
    const s = sets();
    s.record(WS, LEAD, ['t-1', 't-2'], 0);

    expect(s.nothingNew(WS, LEAD, ['t-2', 't-1'])).toBe(true);
  });

  it('is a SUBSET of the same set — losing one names nothing new', () => {
    const s = sets();
    s.record(WS, LEAD, ['t-1', 't-2'], 0);

    expect(s.nothingNew(WS, LEAD, ['t-1'])).toBe(true);
  });

  it('is NOT a set that gained one, however many it kept', () => {
    const s = sets();
    s.record(WS, LEAD, ['t-1', 't-2'], 0);

    expect(s.nothingNew(WS, LEAD, ['t-1', 't-2', 't-3'])).toBe(false);
  });

  it('is never an empty set — something else made that frame', () => {
    const s = sets();
    s.record(WS, LEAD, ['t-1'], 0);

    expect(s.nothingNew(WS, LEAD, [])).toBe(false);
  });

  it('is asked per SESSION, not per board', () => {
    const s = sets();
    s.record(WS, LEAD, ['t-1'], 0);

    expect(s.nothingNew(WS, LEAD, ['t-1'])).toBe(true);
    // A stand-in the escalation addressed instead has been handed nothing.
    expect(s.nothingNew(WS, 'agent-stand-in', ['t-1'])).toBe(false);
  });

  it('is asked per BOARD, not per session across boards', () => {
    const s = sets();
    s.record(WS, LEAD, ['t-1'], 0);

    expect(s.nothingNew('w-riverbend', LEAD, ['t-1'])).toBe(false);
  });
});

describe('forgetting', () => {
  it('drops an entry nobody named for a whole window, so its return is news', () => {
    const s = sets();
    s.record(WS, LEAD, ['t-1', 't-2'], 0);

    // `t-2` stays a finding; `t-1` does not.
    s.observe(WS, ['t-2'], WINDOW + MIN);

    expect(s.nothingNew(WS, LEAD, ['t-1', 't-2'])).toBe(false);
  });

  it('keeps an entry the board still names, however long it stands', () => {
    const s = sets();
    s.record(WS, LEAD, ['t-1'], 0);
    for (let at = MIN; at <= 10 * WINDOW; at += MIN) s.observe(WS, ['t-1'], at);

    expect(s.nothingNew(WS, LEAD, ['t-1'])).toBe(true);
  });

  it('sweeps before it stamps, so an entry back on the very tick is news', () => {
    // The recurrence case: the row cleared, the window ran out, and it went
    // quiet again on the same pass that would have forgotten it. Stamping
    // first would keep it remembered and swallow the return.
    const s = sets();
    s.record(WS, LEAD, ['t-1'], 0);
    s.observe(WS, [], MIN);

    s.observe(WS, ['t-1'], WINDOW + 2 * MIN);

    expect(s.nothingNew(WS, LEAD, ['t-1'])).toBe(false);
  });

  it('forgets the board itself when it is gone', () => {
    const s = sets();
    s.record(WS, LEAD, ['t-1'], 0);

    s.retain(new Set(['w-riverbend']));

    expect(s.nothingNew(WS, LEAD, ['t-1'])).toBe(false);
  });
});

describe('across a restart', () => {
  it('a set written and read back still reads as a repeat', () => {
    const before = sets();
    before.record(WS, LEAD, ['t-2', 't-1'], 0);

    const after = sets();
    after.load(JSON.parse(JSON.stringify(before.toJSON())) as unknown, 5 * MIN);

    expect(after.nothingNew(WS, LEAD, ['t-1', 't-2'])).toBe(true);
  });

  it('CONTROL: without that file the same frame is news again', () => {
    const before = sets();
    before.record(WS, LEAD, ['t-1'], 0);

    const after = sets();
    after.load({}, 5 * MIN);

    expect(after.nothingNew(WS, LEAD, ['t-1'])).toBe(false);
  });

  it('gives every loaded entry a fresh window rather than an expired one', () => {
    const before = sets();
    before.record(WS, LEAD, ['t-1'], 0);

    const after = sets();
    after.load(before.toJSON(), 100 * WINDOW);

    // Loaded at a clock far past the original window: if the load had carried
    // the old seen-time the entry would be forgotten on the next observe.
    after.observe(WS, ['t-1'], 100 * WINDOW + MIN);
    expect(after.nothingNew(WS, LEAD, ['t-1'])).toBe(true);
  });

  it('serialises sorted, so an unchanged memory writes byte-identical text', () => {
    const a = sets();
    a.record(WS, LEAD, ['t-2', 't-1'], 0);
    a.record('w-riverbend', LEAD, ['t-9'], 0);
    const b = sets();
    b.record('w-riverbend', LEAD, ['t-9'], 0);
    b.record(WS, LEAD, ['t-1', 't-2'], 0);

    expect(JSON.stringify(a.toJSON())).toBe(JSON.stringify(b.toJSON()));
  });

  it('keeps every other board when one stored entry is nonsense', () => {
    const s = sets();

    s.load({ [WS]: { [LEAD]: ['t-1'] }, 'w-riverbend': 'not an object' }, 0);

    expect(s.nothingNew(WS, LEAD, ['t-1'])).toBe(true);
  });
});
