/**
 * The tidy-up a timed-out recording leaves on the strip's idle line: the
 * request's three answers, and the small state machine that turns them into a
 * control a person can press.
 *
 * Driven through the real module over a stub `fetch` and a stub runner —
 * nothing here reads source text. Fictional names throughout; the repo is
 * public.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  TIDY_FAILED_NOTE,
  TIDY_LABEL,
  TIDY_NOTHING_LANDED_NOTE,
  TIDY_NOTHING_TO_CHANGE_NOTE,
  TIDY_WORKING_LABEL,
  createMeetingTidyLine,
  runMeetingTidyUp,
} from '../src/meeting-tidy-line.ts';

const reply = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('runMeetingTidyUp', () => {
  it('reports a pass that moved the notes', async () => {
    const out = await runMeetingTidyUp({
      docId: 'd-riverbend',
      meetingId: 'm-1',
      fetchImpl: reply(200, { ok: true, changed: true, touched: 3 }),
    });
    expect(out).toEqual({ kind: 'changed' });
  });

  /** A server that predates the field says nothing, and nothing is not a
   *  claim that the notes stood still. */
  it('treats a missing changed field as a pass that ran', async () => {
    const out = await runMeetingTidyUp({
      docId: 'd-riverbend',
      meetingId: 'm-1',
      fetchImpl: reply(200, { ok: true }),
    });
    expect(out).toEqual({ kind: 'changed' });
  });

  it('tells the two nothings apart', async () => {
    const refused = await runMeetingTidyUp({
      docId: 'd-riverbend',
      meetingId: 'm-1',
      fetchImpl: reply(200, { ok: true, changed: false, proposed: 4, refused: 4 }),
    });
    expect(refused).toEqual({ kind: 'unchanged', note: TIDY_NOTHING_LANDED_NOTE });
    const finished = await runMeetingTidyUp({
      docId: 'd-riverbend',
      meetingId: 'm-1',
      fetchImpl: reply(200, { ok: true, changed: false, proposed: 0 }),
    });
    expect(finished).toEqual({ kind: 'unchanged', note: TIDY_NOTHING_TO_CHANGE_NOTE });
  });

  it("prefers the server's own sentence for a refusal", async () => {
    const out = await runMeetingTidyUp({
      docId: 'd-riverbend',
      meetingId: 'm-1',
      fetchImpl: reply(409, { error: 'That meeting has no transcript.' }),
    });
    expect(out).toEqual({ kind: 'failed', note: 'That meeting has no transcript.' });
  });

  /** The line has to say something either way, so a request that never
   *  arrived is an outcome rather than an exception. */
  it('answers rather than throws when the request never arrives', async () => {
    const out = await runMeetingTidyUp({
      docId: 'd-riverbend',
      meetingId: 'm-1',
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    });
    expect(out).toEqual({ kind: 'failed', note: TIDY_FAILED_NOTE });
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
  function rig(run: (id: string) => Promise<Awaited<ReturnType<typeof runMeetingTidyUp>>>) {
    const onChange = vi.fn();
    const onDone = vi.fn();
    const line = createMeetingTidyLine({ run, onChange, onDone });
    return { line, onChange, onDone };
  }

  it('offers nothing until a meeting is named', () => {
    const { line } = rig(async () => ({ kind: 'changed' }));
    expect(line.view()).toBe(null);
    expect(line.report()).toBe(null);
  });

  it('says it is working while the pass is on the wire, and refuses a second press', async () => {
    let release: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<{ kind: 'changed' }>((resolve) => {
          release = () => resolve({ kind: 'changed' });
        }),
    );
    const { line, onDone } = rig(run);
    line.offer('m-1');
    line.view()?.press();
    expect(line.view()?.label).toBe(TIDY_WORKING_LABEL);
    expect(line.view()?.busy).toBe(true);
    // The control is disabled while busy, but a second call must change
    // nothing even if one arrived.
    line.view()?.press();
    expect(run).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(line.view()).toBe(null);
  });

  it('keeps the offer and reports when the pass changed nothing', async () => {
    const { line, onDone } = rig(async () => ({
      kind: 'unchanged',
      note: TIDY_NOTHING_TO_CHANGE_NOTE,
    }));
    line.offer('m-1');
    line.view()?.press();
    await Promise.resolve();
    await Promise.resolve();
    expect(onDone).not.toHaveBeenCalled();
    expect(line.report()).toBe(TIDY_NOTHING_TO_CHANGE_NOTE);
    expect(line.view()?.label).toBe(TIDY_LABEL);
    expect(line.view()?.busy).toBe(false);
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
    await Promise.resolve();
    await Promise.resolve();
    expect(onDone).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(line.view()).toBe(null);
  });

  /** A runner that rejects would otherwise leave the control saying
   *  "Tidying up…" for the rest of the session. */
  it('recovers the control when the runner rejects', async () => {
    const { line } = rig(() => Promise.reject(new Error('boom')));
    line.offer('m-1');
    line.view()?.press();
    await Promise.resolve();
    await Promise.resolve();
    expect(line.report()).toBe(TIDY_FAILED_NOTE);
    expect(line.view()?.busy).toBe(false);
  });

  it('drops a stale report when a fresh meeting is offered', async () => {
    const { line } = rig(async () => ({ kind: 'failed', note: TIDY_FAILED_NOTE }));
    line.offer('m-1');
    line.view()?.press();
    await Promise.resolve();
    await Promise.resolve();
    expect(line.report()).toBe(TIDY_FAILED_NOTE);
    line.offer('m-2');
    expect(line.report()).toBe(null);
    expect(line.view()?.label).toBe(TIDY_LABEL);
  });
});
