/**
 * The offer to tidy up a meeting's notes (done-when 1: "require explicit
 * human approval").
 *
 * The question every case here asks is whether anything happens WITHOUT a
 * press. Mounting must not, a meeting ending must not, and a meeting ending
 * twice must not — the whole feature is a rewrite of notes people have been
 * reading, so the button is the only thing that may start one.
 *
 * Fictional names throughout; the repo is public.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEANUP_WASH_HOLD_MS, mountMeetingCleanupOffer } from '../src/meeting-cleanup-offer.ts';

let parent: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  parent = document.createElement('div');
  document.body.append(parent);
  history.replaceState(null, '', '/workspaces/w-riverbend/docs/d-ferry');
});
afterEach(() => {
  vi.restoreAllMocks();
});

const offerEl = (): HTMLElement => {
  const el = parent.querySelector<HTMLElement>('.cleanup-offer');
  if (!el) throw new Error('no .cleanup-offer rendered');
  return el;
};
const goEl = (): HTMLButtonElement => {
  const el = offerEl().querySelector<HTMLButtonElement>('.cleanup-offer-go');
  if (!el) throw new Error('no button');
  return el;
};

/** A fetch that records its calls and answers with `reply`. */
function stubFetch(reply: { status?: number; body?: unknown } = {}): typeof fetch & {
  calls: { url: string; method?: string }[];
} {
  const calls: { url: string; method?: string }[] = [];
  const impl = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init?.method ? { method: init.method } : {}) });
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? { ok: true, touched: 2 }), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch & { calls: { url: string; method?: string }[] };
  impl.calls = calls;
  return impl;
}

const mount = (fetchImpl: typeof fetch, liveZone?: { holdWash: (ms: number) => void }) =>
  mountMeetingCleanupOffer({
    docId: 'd-ferry',
    parent,
    fetchImpl,
    // The zone's other members are never reached from here.
    ...(liveZone ? { liveZone: liveZone as never } : {}),
  });

describe('the tidy-up offer', () => {
  it('shows nothing until a recording has ended', () => {
    const f = stubFetch();
    mount(f);
    expect(offerEl().hidden).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it('offers, but runs nothing, when a meeting ends', () => {
    const f = stubFetch();
    const offer = mount(f);
    offer.offer('m-1');
    expect(offerEl().hidden).toBe(false);
    expect(goEl().textContent).toBe('Tidy up these notes');
    // The whole point: an offer on screen has asked the server for nothing.
    expect(f.calls).toEqual([]);
  });

  it('runs the pass on the press, against the meeting that ended', async () => {
    const f = stubFetch();
    const held: number[] = [];
    const offer = mount(f, { holdWash: (ms) => held.push(ms) });
    offer.offer('m-riverbend-1');
    goEl().click();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.calls[0]?.method).toBe('POST');
    expect(f.calls[0]?.url).toBe(
      '/workspaces/w-riverbend/docs/d-ferry/meetings/m-riverbend-1/notes-cleanup',
    );
    // The wash is held BEFORE the request, or the first note it writes lands
    // untinted while the response is still on the wire.
    expect(held).toEqual([CLEANUP_WASH_HOLD_MS]);
    // Done: the notes are the receipt, so the offer goes.
    await vi.waitFor(() => expect(offerEl().hidden).toBe(true));
  });

  it('keeps the offer up and says so when the pass refuses', async () => {
    const f = stubFetch({ status: 409, body: { ok: false, error: 'no transcript' } });
    const offer = mount(f);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() =>
      expect(offerEl().querySelector('.cleanup-offer-note')?.textContent).toBe('no transcript'),
    );
    // Still pressable: a refusal is not a dead end.
    expect(offerEl().hidden).toBe(false);
    expect(goEl().disabled).toBe(false);
  });

  it('withdraws when the next recording starts, and dismisses on request', () => {
    const f = stubFetch();
    const offer = mount(f);
    offer.offer('m-1');
    offer.withdraw();
    expect(offerEl().hidden).toBe(true);
    offer.offer('m-2');
    offerEl().querySelector<HTMLButtonElement>('.cleanup-offer-dismiss')?.click();
    expect(offerEl().hidden).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it('does not run twice on a double press', async () => {
    const f = stubFetch();
    const offer = mount(f);
    offer.offer('m-1');
    goEl().click();
    goEl().click();
    await vi.waitFor(() => expect(offerEl().hidden).toBe(true));
    expect(f.calls).toHaveLength(1);
  });
});
