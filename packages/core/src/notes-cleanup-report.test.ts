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
