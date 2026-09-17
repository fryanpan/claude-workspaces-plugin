/**
 * `blockage-lift.ts`: which moment the board can point to and say "the work
 * could have started again here", and whether anything happened since.
 *
 * The two shapes this file exists to keep apart are the two the task that
 * asked for it measured. A task whose person answered 21 hours ago and which
 * has not moved since IS the finding; a task whose done-when line landed a
 * minute after the report that proved it, and which kept working, is not —
 * and from the outside those two look identical.
 *
 * Every fixture is invented.
 */
import { describe, expect, it } from 'bun:test';
import type { DoneWhenLine } from '@claude-workspaces/core/done-when';
import { LIFT_CLOCK_EPSILON_MS, liftOf, unresumedSince } from '../src/blockage-lift.ts';

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

/** A line with the verdict and stamp the reading turns on, and nothing else
 *  it reads. */
function line(id: string, text: string, verdict?: DoneWhenLine['verdict'], at?: number): DoneWhenLine {
  return {
    id,
    text,
    ...(verdict !== undefined ? { verdict } : {}),
    ...(at !== undefined ? { at } : {}),
  };
}

describe('liftOf — which explicit signal says the blockage lifted', () => {
  it('finds nothing on a task with no answered ask and no met line', () => {
    expect(liftOf({})).toBeUndefined();
    expect(
      liftOf({
        doneWhen: [line('d-1', 'The index rebuilds nightly.'), line('d-2', 'Search reads it.')],
      }),
    ).toBeUndefined();
  });

  it('names an answered ask, with the headline as what is now unblocked', () => {
    const lift = liftOf({
      answered: [{ at: NOW - 21 * HOUR, headline: 'Which key should the rebuild use?' }],
    });
    expect(lift).toEqual({
      kind: 'review-item-answered',
      at: NOW - 21 * HOUR,
      what: 'Which key should the rebuild use?',
    });
  });

  it('names a met line with a later line still open, and what is open now', () => {
    const lift = liftOf({
      doneWhen: [
        line('d-1', 'The index rebuilds nightly.', 'met', NOW - 2 * HOUR),
        line('d-2', 'Search reads the fresh index.'),
        line('d-3', 'The old index is retired.'),
      ],
    });
    expect(lift).toEqual({
      kind: 'done-when-met',
      at: NOW - 2 * HOUR,
      what: 'The index rebuilds nightly.',
      next: 'Search reads the fresh index.',
    });
  });

  it('says nothing when the met line has no open line after it', () => {
    // The completion shape, and the control the task asked for: a task whose
    // last open line just went met is FINISHING, not resuming. Two spellings
    // of it — every line met, and the last line met while earlier ones are
    // still open — because only the second isolates this rule from the
    // auto-done that takes a completed ticket off the board anyway.
    expect(
      liftOf({
        doneWhen: [
          line('d-1', 'The index rebuilds nightly.', 'met', NOW - 3 * HOUR),
          line('d-2', 'Search reads the fresh index.', 'met', NOW - 2 * HOUR),
        ],
      }),
    ).toBeUndefined();
    expect(
      liftOf({
        doneWhen: [
          line('d-1', 'The index rebuilds nightly.'),
          line('d-2', 'Search reads the fresh index.'),
          line('d-3', 'The old index is retired.', 'met', NOW - 2 * HOUR),
        ],
      }),
    ).toBeUndefined();
  });

  it('treats every non-met verdict as open, so a line sent back still counts', () => {
    for (const verdict of ['not-met', 'unchecked', 'owner'] as const) {
      const lift = liftOf({
        doneWhen: [
          line('d-1', 'The index rebuilds nightly.', 'met', NOW - 2 * HOUR),
          line('d-2', 'Search reads the fresh index.', verdict, NOW - HOUR),
        ],
      });
      expect(lift?.next).toBe('Search reads the fresh index.');
    }
  });

  it('skips a met line nobody stamped rather than measuring from the epoch', () => {
    expect(
      liftOf({
        doneWhen: [
          line('d-1', 'The index rebuilds nightly.', 'met'),
          line('d-2', 'Search reads the fresh index.'),
        ],
      }),
    ).toBeUndefined();
  });

  it('takes the NEWEST lift when a task carries both', () => {
    const answered = [{ at: NOW - 48 * HOUR, headline: 'Which key should the rebuild use?' }];
    const doneWhen = [
      line('d-1', 'The index rebuilds nightly.', 'met', NOW - 60_000),
      line('d-2', 'Search reads the fresh index.'),
    ];
    // The line is newer, so the reading rests on it — an answer from two days
    // ago says nothing about a task that reported a minute ago.
    expect(liftOf({ answered, doneWhen })?.kind).toBe('done-when-met');
    // …and the other way round, with the same two facts swapped.
    expect(
      liftOf({
        answered: [{ at: NOW - 60_000, headline: 'Which key should the rebuild use?' }],
        doneWhen: [
          line('d-1', 'The index rebuilds nightly.', 'met', NOW - 48 * HOUR),
          line('d-2', 'Search reads the fresh index.'),
        ],
      })?.kind,
    ).toBe('review-item-answered');
  });
});

describe('unresumedSince — has the lift stood with nothing done about it', () => {
  const quietMs = 30 * 60_000;
  const answered = liftOf({
    answered: [{ at: NOW - 21 * HOUR, headline: 'Which key should the rebuild use?' }],
  });

  it('names the 21-hour shape: past the window, nothing since', () => {
    expect(answered).toBeDefined();
    if (!answered) return;
    expect(
      unresumedSince(answered, { now: NOW, sinceActivityMs: 21 * HOUR, quietMs }),
    ).toBe(true);
  });

  it('stays silent on the connector timeline — work landed 61 seconds later', () => {
    // The measured control. The line went met at 13:54:31Z and the next
    // report landed 62 seconds after it; the task was working perfectly. It
    // is silent here whatever the window, because the row moved AFTER the
    // lift — which is the guard that does the work. Sampled a day later, so
    // the quiet window has long since passed and cannot be what holds it.
    const lift = liftOf({
      doneWhen: [
        line('d-1', 'The first report lands.', 'met', NOW - 24 * HOUR),
        line('d-2', 'The remaining plan is delivered.'),
      ],
    });
    expect(lift).toBeDefined();
    if (!lift) return;
    expect(
      unresumedSince(lift, { now: NOW, sinceActivityMs: 24 * HOUR - 62_000, quietMs }),
    ).toBe(false);
  });

  it('stays silent inside the window — an answer a minute old is one somebody may be reading', () => {
    const fresh = liftOf({ answered: [{ at: NOW - 61_000, headline: 'Move Plan onto the row?' }] });
    expect(fresh).toBeDefined();
    if (!fresh) return;
    expect(unresumedSince(fresh, { now: NOW, sinceActivityMs: 61_000, quietMs })).toBe(false);
  });

  it('stays silent on a task answered long ago that has been worked since', () => {
    expect(answered).toBeDefined();
    if (!answered) return;
    // Answered 21 hours ago, worked 40 minutes ago: quiet past the window and
    // NOT a finding. Without the second guard this is the row a status-age
    // reading names, which is the 44.6-hour false positive.
    expect(unresumedSince(answered, { now: NOW, sinceActivityMs: 40 * 60_000, quietMs })).toBe(
      false,
    );
  });

  it('tolerates the lift’s own row edit, and nothing wider', () => {
    expect(answered).toBeDefined();
    if (!answered) return;
    // The write the lift itself causes lands at-or-just-after the lift, so
    // the row's newest activity reads fractionally NEWER than the lift.
    expect(
      unresumedSince(answered, {
        now: NOW,
        sinceActivityMs: 21 * HOUR - LIFT_CLOCK_EPSILON_MS,
        quietMs,
      }),
    ).toBe(true);
    // One millisecond past the tolerance is somebody else's write.
    expect(
      unresumedSince(answered, {
        now: NOW,
        sinceActivityMs: 21 * HOUR - LIFT_CLOCK_EPSILON_MS - 1,
        quietMs,
      }),
    ).toBe(false);
  });

  it('stays silent on a lift stamped in the future by a skewed clock', () => {
    const ahead = liftOf({ answered: [{ at: NOW + HOUR, headline: 'Move Plan onto the row?' }] });
    expect(ahead).toBeDefined();
    if (!ahead) return;
    expect(unresumedSince(ahead, { now: NOW, sinceActivityMs: 48 * HOUR, quietMs })).toBe(false);
  });
});
