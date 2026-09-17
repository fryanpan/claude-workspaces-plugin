/**
 * The tidy-up a timed-out recording leaves on the strip's idle line: what the
 * request's answers say on a one-line surface, and the small state machine
 * that turns them into a control a person can press.
 *
 * WHAT CHANGED AND WHY THE CASES LOOK LIKE THIS. This module used to read
 * `body.error` — a field the route does not send for a refusal — so every
 * cause collapsed into one sentence that named none of them and left the
 * control live. The words now come from `readCleanupReply` in core, the same
 * reader the dialog uses, so the cases below drive the reply shapes the ROUTE
 * builds (`packages/server/src/routes/meetings-calendar.ts`, whose `reason`
 * is the `NotesCleanupRefusal` union) rather than a body hand-written to suit
 * the assertion. `meeting-tidy-agrees.test.ts` puts the same replies through
 * both surfaces at once.
 *
 * Driven through the real module over a stub `fetch` and a stub runner —
 * nothing here reads source text. Fictional names throughout; the repo is
 * public.
 */

import { readCleanupReply } from '@claude-workspaces/core';
import { describe, expect, it, vi } from 'vitest';
import {
  TIDY_LABEL,
  TIDY_RETRY_LABEL,
  TIDY_WORKING_LABEL,
  createMeetingTidyLine,
  runMeetingTidyUp,
} from '../src/meeting-tidy-line.ts';
import { REPLIES, routeRefusal } from './meeting-tidy-replies.ts';

const reply = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const run = (fetchImpl: typeof fetch) =>
  runMeetingTidyUp({ docId: 'd-riverbend', meetingId: 'm-1', fetchImpl });

describe('runMeetingTidyUp', () => {
  it('reports a pass that moved the notes', async () => {
    const out = await run(reply(REPLIES.changed.status, REPLIES.changed.body));
    expect(out).toEqual({ kind: 'changed' });
  });

  /** A server that predates the field says nothing, and nothing is not a
   *  claim that the notes stood still. */
  it('treats a missing changed field as a pass that ran', async () => {
    const out = await run(reply(200, { ok: true }));
    expect(out).toEqual({ kind: 'changed' });
  });

  it('tells the two nothings apart', async () => {
    const refused = await run(reply(200, REPLIES.nothingLanded.body));
    expect(refused).toEqual({
      kind: 'reported',
      note: 'Nothing changed — none of these edits could be made to the notes.',
      // Every rule that drops an edit is a fact about the document as it
      // stood, and the document is live.
      retry: true,
    });
    const finished = await run(reply(200, REPLIES.nothingToChange.body));
    expect(finished).toEqual({
      kind: 'reported',
      note: 'Nothing changed — the tidy-up read the whole meeting and found nothing to improve.',
      retry: false,
    });
  });

  /**
   * THE DEFECT THIS REWORK EXISTS FOR. Each of these is a different piece of
   * news, and every one of them used to read "The tidy-up could not run — the
   * notes are unchanged." with the control coming back live underneath it.
   */
  it('names the cause of a refusal, one reason at a time', async () => {
    const said = new Map<string, { note: string; retry: boolean }>();
    for (const reason of [
      'no-composer',
      'recording',
      'no-transcript',
      'no-section',
      'transcript-too-long',
      'no-doc',
      'compose-failed',
    ] as const) {
      const out = await run(reply(409, routeRefusal(reason)));
      if (out.kind !== 'reported') throw new Error(`${reason} did not report`);
      said.set(reason, { note: out.note, retry: out.retry });
    }
    // Seven reasons, seven sentences: no two of them collapse into one.
    expect(new Set([...said.values()].map((v) => v.note)).size).toBe(7);
    for (const [reason, v] of said) {
      expect(v.note, reason).not.toBe('The tidy-up could not run.');
    }
    // And the sentence names what happened, not a code.
    expect(said.get('no-composer')?.note).toContain('no model key');
    expect(said.get('recording')?.note).toContain('a recording is going on this doc');
    expect(said.get('no-transcript')?.note).toContain('left no transcript');
  });

  /**
   * An answer that cannot change is what takes the control down. A server
   * with no model key answers the same way until somebody sets one, so an
   * offer standing in front of it is a press that fails for ever.
   */
  it('says which refusals another press could not answer differently', async () => {
    const retryOf = async (reason: string): Promise<boolean> => {
      const out = await run(reply(409, routeRefusal(reason)));
      if (out.kind !== 'reported') throw new Error(`${reason} did not report`);
      return out.retry;
    };
    expect(await retryOf('no-composer')).toBe(false);
    expect(await retryOf('no-transcript')).toBe(false);
    expect(await retryOf('no-section')).toBe(false);
    expect(await retryOf('transcript-too-long')).toBe(false);
    expect(await retryOf('no-doc')).toBe(false);
    // Control: the two a person can actually clear.
    expect(await retryOf('recording')).toBe(true);
    expect(await retryOf('compose-failed')).toBe(true);
  });

  /** The route's own early 409s carry a sentence and no reason code — a live
   *  meeting, a meeting id that is not on this doc. */
  it("prefers the server's own sentence for a refusal", async () => {
    const out = await run(reply(409, { error: 'That meeting has no transcript.' }));
    expect(out).toEqual({
      kind: 'reported',
      note: 'That meeting has no transcript.',
      retry: true,
    });
  });

  /** The line has to say something either way, so a request that never
   *  arrived is an outcome rather than an exception. */
  it('answers rather than throws when the request never arrives', async () => {
    const out = await runMeetingTidyUp({
      docId: 'd-riverbend',
      meetingId: 'm-1',
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    });
    expect(out).toEqual({
      kind: 'reported',
      note: 'The tidy-up could not run — the request did not reach the server.',
      retry: true,
    });
  });

  it('holds the settle wash open across the request, before it is sent', async () => {
    const holdWash = vi.fn();
    let heldBeforeSend: number | undefined;
    const fetchImpl = (async () => {
      heldBeforeSend = holdWash.mock.calls.length;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await runMeetingTidyUp({
      docId: 'd-riverbend',
      meetingId: 'm-1',
      fetchImpl,
      // Only the one method is reached, so the zone is stubbed to it.
      liveZone: { holdWash } as unknown as Parameters<typeof runMeetingTidyUp>[0]['liveZone'],
    });
    // Notes can land while the response is still on the wire.
    expect(heldBeforeSend).toBe(1);
  });

  it('addresses the meeting it was given', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await runMeetingTidyUp({ docId: 'd-riverbend', meetingId: 'm-harbor', fetchImpl });
    expect(seen[0]).toContain('d-riverbend');
    expect(seen[0]).toContain('m-harbor');
    expect(seen[0]).toContain('notes-cleanup');
  });
});

describe('the offer on the line', () => {
  function rig(runner: (id: string) => Promise<Awaited<ReturnType<typeof runMeetingTidyUp>>>) {
    const onChange = vi.fn();
    const onDone = vi.fn();
    const line = createMeetingTidyLine({ run: runner, onChange, onDone });
    return { line, onChange, onDone };
  }

  /** Two microtask turns is what `press` costs: the await, then the state
   *  written after it. */
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('offers nothing until a meeting is named', () => {
    const { line } = rig(async () => ({ kind: 'changed' }));
    expect(line.view()).toBe(null);
    expect(line.report()).toBe(null);
  });

  it('says it is working while the pass is on the wire, and refuses a second press', async () => {
    let release: (() => void) | undefined;
    const runner = vi.fn(
      () =>
        new Promise<{ kind: 'changed' }>((resolve) => {
          release = () => resolve({ kind: 'changed' });
        }),
    );
    const { line, onDone } = rig(runner);
    line.offer('m-1');
    line.view()?.press();
    expect(line.view()?.label).toBe(TIDY_WORKING_LABEL);
    expect(line.view()?.busy).toBe(true);
    // The control is disabled while busy, but a second call must change
    // nothing even if one arrived.
    line.view()?.press();
    expect(runner).toHaveBeenCalledTimes(1);
    release?.();
    await flush();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(line.view()).toBe(null);
  });

  it('keeps the offer as Try again when another press could answer differently', async () => {
    const { line, onDone } = rig(async () => ({
      kind: 'reported',
      note: 'Nothing changed — none of these edits could be made to the notes.',
      retry: true,
    }));
    line.offer('m-1');
    line.view()?.press();
    await flush();
    expect(onDone).not.toHaveBeenCalled();
    expect(line.report()).toBe('Nothing changed — none of these edits could be made to the notes.');
    // By now the question has been answered, so the control is a repeat.
    expect(line.view()?.label).toBe(TIDY_RETRY_LABEL);
    expect(line.view()?.busy).toBe(false);
  });

  /**
   * THE SECOND HALF OF THE DEFECT. A reply that will say the same thing for
   * ever leaves its sentence and takes its control: an underlined offer that
   * fails identically on every press is worse than no offer at all.
   */
  it('retires the offer when another press could not answer differently', async () => {
    const runner = vi.fn(async () => ({
      kind: 'reported' as const,
      note: 'The tidy-up could not run — this server has no model key configured.',
      retry: false,
    }));
    const { line } = rig(runner);
    line.offer('m-1');
    line.view()?.press();
    await flush();
    // The sentence stays; the control does not.
    expect(line.report()).toBe(
      'The tidy-up could not run — this server has no model key configured.',
    );
    expect(line.view()).toBe(null);
    // And nothing can ask again, including a caller holding the old view.
    expect(runner).toHaveBeenCalledTimes(1);
  });

  /** A retired offer is retired for THAT meeting. The next one starts clean. */
  it('offers again for a fresh meeting after a retired one', async () => {
    const { line } = rig(async () => ({
      kind: 'reported',
      note: 'The tidy-up could not run — this server has no model key configured.',
      retry: false,
    }));
    line.offer('m-1');
    line.view()?.press();
    await flush();
    expect(line.view()).toBe(null);
    line.offer('m-2');
    expect(line.report()).toBe(null);
    expect(line.view()?.label).toBe(TIDY_LABEL);
  });

  /**
   * A new recording withdraws the offer, and that can happen while the pass
   * is still on the wire. Answering afterwards would put a control back on a
   * line that is now about a different meeting.
   */
  it('says nothing for a meeting that was superseded mid-request', async () => {
    let release: ((v: { kind: 'changed' }) => void) | undefined;
    const { line, onChange, onDone } = rig(
      () => new Promise<{ kind: 'changed' }>((resolve) => (release = resolve)),
    );
    line.offer('m-1');
    line.view()?.press();
    onChange.mockClear();
    line.withdraw();
    release?.({ kind: 'changed' });
    await flush();
    expect(onDone).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(line.view()).toBe(null);
  });

  /** A runner that rejects would otherwise leave the control saying
   *  "Tidying up…" for the rest of the session. It ran nothing, so the offer
   *  stands. */
  it('recovers the control when the runner rejects', async () => {
    const { line } = rig(() => Promise.reject(new Error('boom')));
    line.offer('m-1');
    line.view()?.press();
    await flush();
    expect(line.report()).toBe('The tidy-up could not run — the request did not reach the server.');
    expect(line.view()?.busy).toBe(false);
    expect(line.view()?.label).toBe(TIDY_RETRY_LABEL);
  });

  it('drops a stale report when a fresh meeting is offered', async () => {
    const { line } = rig(async () => ({
      kind: 'reported',
      note: 'The tidy-up could not run — a recording is going on this doc.',
      retry: true,
    }));
    line.offer('m-1');
    line.view()?.press();
    await flush();
    expect(line.report()).toBe('The tidy-up could not run — a recording is going on this doc.');
    line.offer('m-2');
    expect(line.report()).toBe(null);
    expect(line.view()?.label).toBe(TIDY_LABEL);
  });

  /**
   * The words are core's, not this module's: nothing here re-spells a reply.
   * Read straight off the shared reader, so a change to either side that
   * moved them apart fails here.
   */
  it('says exactly what the shared reader says about the same reply', async () => {
    const out = await run(reply(409, routeRefusal('no-composer')));
    const core = readCleanupReply(routeRefusal('no-composer'));
    expect(out).toEqual({ kind: 'reported', note: core.headline, retry: core.retry });
  });
});
