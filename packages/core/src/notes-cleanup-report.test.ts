/**
 * Reading one tidy-up reply into words a person can act on.
 *
 * WHAT EACH CASE IS PROTECTING. The failure this module exists for is a pass
 * that changed nothing and said nothing, so the cases are about telling the
 * FOUR nothings apart and about never losing the reason: a reply whose every
 * edit was refused must not read like one that found the notes finished, a
 * model call that never answered must not read like either, and a reply
 * carrying reasons must surface them however many edits share a rule.
 *
 * Fictional names and fictional block ids throughout; the repo is public.
 */

import { describe, expect, it } from 'vitest';
import {
  cleanupReasonLine,
  groupCleanupReasons,
  readCleanupReply,
} from './notes-cleanup-report.ts';

/** The gate's own line shape: `"<op> <id>: <rule>"`. */
const refusal = (op: string, id: string, rule: string): string => `${op} ${id}: ${rule}`;
const NOT_OURS = 'the document does not record the block as the note-taker’s own';
const COMMENTED = 'somebody has commented on the block';

describe('grouping the reasons a tidy-up dropped an edit', () => {
  it('counts each rule once, commonest first', () => {
    expect(
      groupCleanupReasons([
        refusal('replace_block', 'b1', NOT_OURS),
        refusal('delete_block', 'b2', COMMENTED),
        refusal('replace_block', 'b3', NOT_OURS),
        refusal('replace_block', 'b4', NOT_OURS),
      ]),
    ).toEqual([
      { rule: NOT_OURS, count: 3 },
      { rule: COMMENTED, count: 1 },
    ]);
  });

  it('keeps a rule that carries its own colon whole', () => {
    // The applier's failures are `"<op>: <reason>"` and a reason may name a
    // value with a colon in it. Splitting on the LAST colon would cut it.
    const [only] = groupCleanupReasons(['replace_block: nothing to nest: b7 is not in a list']);
    expect(only).toEqual({ rule: 'nothing to nest: b7 is not in a list', count: 1 });
  });

  it('orders ties by rule, so two readings of one pass agree', () => {
    const lines = [
      refusal('delete_block', 'b1', COMMENTED),
      refusal('replace_block', 'b2', NOT_OURS),
    ];
    expect(groupCleanupReasons(lines).map((g) => g.rule)).toEqual(
      groupCleanupReasons([...lines].reverse()).map((g) => g.rule),
    );
  });

  it('reads no lines at all as no reasons, never as a reason', () => {
    expect(groupCleanupReasons(undefined)).toEqual([]);
    expect(groupCleanupReasons([])).toEqual([]);
  });

  it('says how many edits a rule dropped, singular and plural', () => {
    expect(cleanupReasonLine({ rule: COMMENTED, count: 1 })).toBe(`1 edit — ${COMMENTED}`);
    expect(cleanupReasonLine({ rule: COMMENTED, count: 4 })).toBe(`4 edits — ${COMMENTED}`);
  });
});

describe('reading a tidy-up reply', () => {
  it('reads a pass that moved the document as needing no words', () => {
    const r = readCleanupReply({ ok: true, changed: true, proposed: 5 });
    expect(r.kind).toBe('changed');
    expect(r.headline).toBe('');
    expect(r.recovery).toBe('');
  });

  it('reads a reply that does not say whether it changed anything as having changed something', () => {
    // A server predating `changed` sends nothing, and nothing is not a claim
    // that the notes are untouched.
    expect(readCleanupReply({ ok: true, proposed: 3 }).kind).toBe('changed');
  });

  it('tells a pass with nothing to do apart from one whose edits were all refused', () => {
    const finished = readCleanupReply({ ok: true, changed: false, proposed: 0, refused: 0 });
    const blocked = readCleanupReply({
      ok: true,
      changed: false,
      proposed: 16,
      refused: 16,
      refusals: Array.from({ length: 16 }, (_, i) => refusal('replace_block', `b${i}`, NOT_OURS)),
    });
    expect(finished.kind).toBe('nothing-to-change');
    expect(blocked.kind).toBe('nothing-landed');
    expect(finished.headline).not.toBe(blocked.headline);
    // The one that found the notes finished asks nothing of the reader.
    expect(finished.reasons).toEqual([]);
    expect(finished.recovery).toBe('');
    expect(finished.retry).toBe(false);
  });

  it('carries every rule of a fully refused pass, and a recovery for the commonest', () => {
    const r = readCleanupReply({
      ok: true,
      changed: false,
      proposed: 5,
      refused: 5,
      refusals: [
        refusal('delete_block', 'b1', COMMENTED),
        refusal('delete_block', 'b2', COMMENTED),
        refusal('delete_block', 'b3', COMMENTED),
        refusal('replace_block', 'b4', NOT_OURS),
        refusal('replace_block', 'b5', NOT_OURS),
      ],
    });
    expect(r.reasons).toEqual([
      { rule: COMMENTED, count: 3 },
      { rule: NOT_OURS, count: 2 },
    ]);
    // The commonest rule is the one worth acting on, and its advice names the
    // thing a person can actually do.
    expect(r.recovery).toContain('Resolve the threads');
    expect(r.retry).toBe(true);
  });

  it('counts an edit the applier failed beside one the gate refused', () => {
    // Both are edits that did not reach the notes, and a reader chasing "why
    // did nothing change" needs them in one list.
    const r = readCleanupReply({
      ok: true,
      changed: false,
      proposed: 2,
      refused: 1,
      refusals: [refusal('replace_block', 'b1', NOT_OURS)],
      failed: 1,
      failures: ['nest_blocks: nothing to nest'],
    });
    expect(r.reasons.map((g) => g.rule).sort()).toEqual([NOT_OURS, 'nothing to nest'].sort());
  });

  it('reads a compose that never answered as a failure with something to do', () => {
    const r = readCleanupReply({ ok: false, reason: 'compose-failed' });
    expect(r.kind).toBe('could-not-run');
    expect(r.headline).toContain('could not run');
    expect(r.recovery).toContain('unchanged');
    expect(r.retry).toBe(true);
  });

  it('reads a refusal nothing can change as one not worth pressing again', () => {
    for (const reason of ['no-composer', 'no-transcript', 'transcript-too-long', 'no-section']) {
      const r = readCleanupReply({ ok: false, reason });
      expect(r.kind, reason).toBe('could-not-run');
      expect(r.retry, reason).toBe(false);
      expect(r.recovery.length, reason).toBeGreaterThan(0);
    }
  });

  it('never renders a reason code the build has not heard of', () => {
    const r = readCleanupReply({ ok: false, reason: 'some-reason-from-a-newer-server' });
    expect(r.headline).not.toContain('some-reason-from-a-newer-server');
    expect(r.headline).toContain('could not run');
    expect(r.retry).toBe(true);
  });

  it("prefers the server's own sentence to a reason code", () => {
    const r = readCleanupReply({ ok: false, error: 'meeting is still recording — stop it first' });
    expect(r.headline).toBe('meeting is still recording — stop it first');
  });

  it('never leaves a failure without something to say about the notes', () => {
    for (const reply of [
      { ok: false },
      { ok: false, reason: 'recording' },
      { ok: true, changed: false, proposed: 1, refused: 1 },
    ]) {
      const r = readCleanupReply(reply);
      expect(r.headline.length, JSON.stringify(reply)).toBeGreaterThan(0);
      expect(r.recovery.length, JSON.stringify(reply)).toBeGreaterThan(0);
    }
  });

  it('names no button, so the button can name itself', () => {
    // The recovery line is rendered beside a control whose label depends on
    // `retry`; a sentence saying "press Tidy up" would contradict it the
    // moment that label reads "Try again".
    for (const reply of [
      { ok: false, reason: 'compose-failed' },
      { ok: false, reason: 'no-composer' },
      { ok: false, reason: 'recording' },
      { ok: true, changed: false, proposed: 2, refused: 2 },
    ]) {
      expect(readCleanupReply(reply).recovery, JSON.stringify(reply)).not.toMatch(
        /Tidy up|Try again/,
      );
    }
  });
});

/**
 * THE APPLIER'S HALF OF THE SAME LIST.
 *
 * The gate writes a sentence per dropped edit; the applier writes its error
 * CODE. Both arrays reach one list, so the 15 September shape put "3 edits —
 * unknown-block" directly under "1 edit — somebody has commented on the
 * block" — a code identifier in a report addressed to a person, beside the
 * English that made it look deliberate.
 */
describe('what the applier says, said in English', () => {
  it('reads every applier code as a sentence, never as the code', () => {
    const codes = [
      'unknown-block',
      'not-a-heading',
      'parse-failed',
      'empty',
      'no-range',
      'suggest-failed',
      'not-a-list-item',
      'not-yours',
      'not-a-sibling',
      'nothing-to-nest',
    ];
    const rules = groupCleanupReasons(codes.map((c) => `replace_block: ${c}`)).map((g) => g.rule);
    // Ten codes, and not one of them survives as itself.
    for (const code of codes) expect(rules, code).not.toContain(code);
    // …and nothing is empty or a hyphenated identifier wearing a space.
    for (const rule of rules) {
      expect(rule.length).toBeGreaterThan(12);
      expect(rule).toMatch(/ /);
    }
  });

  it('gives the gate and the applier ONE row when they name one fact', () => {
    // A missing block is a missing block, whether the gate saw it first or
    // the applier did. Two rows saying it in two ways is how a reader
    // concludes there were two problems.
    const groups = groupCleanupReasons([
      refusal('replace_block', 'b1', 'the block is not in the document'),
      'delete_block: unknown-block',
      'nest_blocks: unknown-block',
    ]);
    expect(groups).toEqual([{ rule: 'the block is not in the document', count: 3 }]);
    expect(cleanupReasonLine(groups[0] as { rule: string; count: number })).toBe(
      '3 edits — the block is not in the document',
    );
  });

  it('leaves a code it has never heard of exactly as it arrived', () => {
    // A wrong guess reads as fact; an unfamiliar code at least reads as
    // something to look up.
    expect(groupCleanupReasons(['replace_block: some-new-verdict'])).toEqual([
      { rule: 'some-new-verdict', count: 1 },
    ]);
  });
});

/**
 * THE RECOVERY LINE IS THE ONE A PERSON CAN ACT ON.
 *
 * It used to be the biggest group's line and nothing else, and on the real 15
 * September run the biggest group was `unknown-block`, which matched no
 * recovery at all because it was still a code. Two comment-blocked edits sat
 * under it carrying the only actionable step in the report, and reading the
 * top group alone printed the fallback — the sentence that says there is
 * nothing to do.
 */
describe('which recovery a report of several rules offers', () => {
  const dropped = (reply: Parameters<typeof readCleanupReply>[0]) =>
    readCleanupReply(reply).recovery;

  const HEADING = "the block is the meeting's own section heading";
  const FALLBACK = 'The notes are unchanged, and nothing changes them on its own.';

  it('takes the actionable rule over the bigger pile that is not', () => {
    // Three edits dropped for a rule nobody can act on — the model addressed
    // the section heading — and two for one they can.
    expect(
      dropped({
        ok: true,
        changed: false,
        proposed: 5,
        refused: 5,
        refusals: [
          refusal('replace_block', 'b1', HEADING),
          refusal('replace_block', 'b2', HEADING),
          refusal('delete_block', 'b3', HEADING),
          refusal('delete_block', 'b8', COMMENTED),
          refusal('replace_block', 'b9', COMMENTED),
        ],
      }),
    ).toContain('Resolve the threads');
    // The control on the same shape: take the comment-blocked pair out and
    // there genuinely is nothing to act on, so the fallback is right. A
    // reading in which every reply returns the actionable line fails here.
    expect(
      dropped({
        ok: true,
        changed: false,
        proposed: 3,
        refused: 3,
        refusals: [
          refusal('replace_block', 'b1', HEADING),
          refusal('replace_block', 'b2', HEADING),
          refusal('delete_block', 'b3', HEADING),
        ],
      }),
    ).toBe(FALLBACK);
  });

  it('still prefers the commonest among the rules that ARE actionable', () => {
    // Choosing "actionable" must not mean choosing the smallest: the groups
    // arrive commonest-first and the first actionable match wins.
    expect(
      dropped({
        ok: true,
        changed: false,
        proposed: 4,
        refused: 4,
        refusals: [
          refusal('replace_block', 'b1', NOT_OURS),
          refusal('replace_block', 'b2', NOT_OURS),
          refusal('replace_block', 'b3', NOT_OURS),
          refusal('delete_block', 'b4', COMMENTED),
        ],
      }),
    ).toContain('Editing them yourself');
  });

  it('gives the 15 September run a step instead of the fallback', () => {
    // Its shape exactly: three applier failures on blocks that had moved,
    // two gate refusals on blocks under discussion. While `unknown-block`
    // was still a code it matched no recovery, so the biggest group handed
    // back the fallback. Read as the sentence it means, it carries its own
    // step — and either way the report no longer says there is nothing to do.
    const recovery = dropped({
      ok: true,
      changed: false,
      proposed: 5,
      refused: 2,
      refusals: [
        refusal('delete_block', 'b8', COMMENTED),
        refusal('replace_block', 'b9', COMMENTED),
      ],
      failed: 3,
      failures: [
        'replace_block: unknown-block',
        'replace_block: unknown-block',
        'nest_blocks: unknown-block',
      ],
    });
    expect(recovery).not.toBe(FALLBACK);
    expect(recovery).toContain('Running it again');
  });
});
