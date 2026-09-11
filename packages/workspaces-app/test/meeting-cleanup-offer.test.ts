/**
 * The offer to tidy up a meeting's notes (done-when 1: "require explicit
 * human approval").
 *
 * The question every case here asks is whether anything happens WITHOUT a
 * press. Mounting must not, a meeting ending must not, and a meeting ending
 * twice must not — the whole feature is a rewrite of notes people have been
 * reading, so the button is the only thing that may start one.
 *
 * And the question the first case asks is whether anything is on screen
 * without a recording having ended, because that is how this shipped: the
 * dialog stood open on every doc, over the prose, with no meeting to tidy, so
 * pressing it did nothing. Its visibility is CSS, not this module's logic, so
 * the computed value is read in `cleanup-offer-css.test.ts`; what is read
 * here is that the dialog is never RAISED except by `offer()`.
 *
 * Fictional names throughout; the repo is public.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEANUP_WASH_HOLD_MS, mountMeetingCleanupOffer } from '../src/meeting-cleanup-offer.ts';

let parent: HTMLElement;
/**
 * Every mount this file makes, destroyed when the case ends.
 *
 * Not hygiene for its own sake: the dialog's Tab trap and its Escape handler
 * are bound to `document`, so a mount left alive keeps judging keystrokes in
 * every case that follows — emptying the body detaches its element and leaves
 * its listeners. A leaked mount made three later cases read the previous
 * case's dialog.
 */
const mounted: { destroy: () => void }[] = [];

beforeEach(() => {
  document.body.innerHTML = '';
  parent = document.createElement('div');
  document.body.append(parent);
  history.replaceState(null, '', '/workspaces/w-riverbend/docs/d-ferry');
});
afterEach(() => {
  for (const m of mounted.splice(0)) m.destroy();
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
const dismissEl = (): HTMLButtonElement => {
  const el = offerEl().querySelector<HTMLButtonElement>('.cleanup-offer-dismiss');
  if (!el) throw new Error('no dismiss button');
  return el;
};
const noteEl = (): HTMLElement => {
  const el = offerEl().querySelector<HTMLElement>('.cleanup-offer-note');
  if (!el) throw new Error('no note');
  return el;
};
const tab = (shiftKey = false): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(ev);
  return ev;
};
const shiftTab = (): KeyboardEvent => tab(true);
/** Escape, dispatched where a real one lands: the focused control. */
const escape = (): void => {
  (document.activeElement ?? document).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
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

/**
 * A fetch whose every call is answered when the case says so.
 *
 * `read(i)` is how a case waits for the CALLER to have finished with a reply
 * rather than for the reply to have been sent: it flips once the body has
 * been read, and `vi.waitFor` polls on a timer, so everything queued behind
 * that read has run by the time it is seen. Asserting straight after
 * `settle` would be asking the question before the answer arrived.
 */
function deferredFetch(): {
  impl: typeof fetch;
  calls: { url: string }[];
  settle: (i: number, body: unknown, status?: number) => void;
  reject: (i: number) => void;
  read: (i: number) => boolean;
} {
  const calls: { url: string }[] = [];
  const consumed: boolean[] = [];
  const pending: { resolve: (r: Response) => void; reject: (e: Error) => void }[] = [];
  const impl = ((url: string) => {
    calls.push({ url: String(url) });
    return new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  }) as typeof fetch;
  return {
    impl,
    calls,
    settle: (i, body, status = 200) => {
      const res = new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
      const asJson = res.json.bind(res);
      res.json = async () => {
        const value: unknown = await asJson();
        consumed[i] = true;
        return value;
      };
      pending[i]?.resolve(res);
    },
    reject: (i) => {
      consumed[i] = true;
      pending[i]?.reject(new Error('offline'));
    },
    read: (i) => consumed[i] === true,
  };
}

const mount = (fetchImpl: typeof fetch, liveZone?: { holdWash: (ms: number) => void }) => {
  const offer = mountMeetingCleanupOffer({
    docId: 'd-ferry',
    parent,
    fetchImpl,
    // The zone's other members are never reached from here.
    ...(liveZone ? { liveZone: liveZone as never } : {}),
  });
  mounted.push(offer);
  return offer;
};

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
    // A question with two answers, and nothing said until one is pressed.
    expect(goEl().textContent).toBe('Tidy up');
    expect(dismissEl().textContent).toBe('Not now');
    expect(noteEl().hidden).toBe(true);
    // The whole point: an offer on screen has asked the server for nothing.
    expect(f.calls).toEqual([]);
  });

  it('is a dialog, addressed to the question it asks', () => {
    const f = stubFetch();
    mount(f).offer('m-1');
    const card = offerEl().querySelector('.cleanup-offer-card');
    expect(card?.getAttribute('role')).toBe('dialog');
    expect(card?.getAttribute('aria-modal')).toBe('true');
    const labelledBy = card?.getAttribute('aria-labelledby') ?? '';
    expect(offerEl().querySelector(`#${labelledBy}`)?.textContent).toBe('Tidy up these notes?');
  });

  it('says it is working while the pass is on the wire, and refuses both answers', async () => {
    const f = deferredFetch();
    const offer = mount(f.impl);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    // The dialog stays up and reports, rather than vanishing on the press.
    expect(offerEl().hidden).toBe(false);
    expect(noteEl().hidden).toBe(false);
    expect(noteEl().textContent).toBe('Tidying up these notes…');
    expect(goEl().disabled).toBe(true);
    expect(dismissEl().disabled).toBe(true);
    // …and nothing closes over writes that are already coming: not the
    // disabled answers, not Escape, not the scrim.
    dismissEl().click();
    escape();
    offerEl().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(offerEl().hidden).toBe(false);
    // Then it comes back: the notes behind it are the receipt.
    f.settle(0, { ok: true, touched: 2 });
    await vi.waitFor(() => expect(offerEl().hidden).toBe(true));
  });

  it('keeps Tab inside the dialog, including while both answers are refused', async () => {
    // `aria-modal` moves no focus on its own. Without the trap, Tab lands on
    // the prose under the scrim — and while the pass runs there is nothing in
    // the card to hold it at all, because both answers are disabled.
    const outside = document.createElement('button');
    document.body.append(outside);
    const f = deferredFetch();
    const offer = mount(f.impl);
    offer.offer('m-1');
    expect(document.activeElement).toBe(goEl());
    // At the last stop, Tab wraps to the first rather than leaving.
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dismissEl());
    expect(shiftTab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(goEl());
    // Focus already outside is pulled back — the branch a card-scoped
    // listener could never see.
    outside.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dismissEl());
    // And with the request on the wire, nothing in the card can take it.
    goEl().click();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    outside.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it('leaves Tab alone once the dialog is closed', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    mount(stubFetch());
    outside.focus();
    expect(tab().defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it('takes the Escape the layers under it would otherwise have taken', () => {
    // A recording can end while a thread modal is open, and this dialog is
    // the layer on top when it does. Those layers keep their own Escape
    // handlers on `document`, in the bubble phase; between two listeners on
    // one node the winner is whichever was added first, which nothing here
    // controls — so this one runs in the capture phase instead.
    const underneath = vi.fn();
    document.addEventListener('keydown', underneath);
    try {
      const offer = mount(stubFetch());
      // Closed, it takes nothing: the layer under it still gets its press.
      escape();
      expect(underneath).toHaveBeenCalledTimes(1);
      offer.offer('m-1');
      escape();
      expect(offerEl().hidden).toBe(true);
      expect(underneath).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', underneath);
    }
  });

  it('closes on Escape and on the scrim, without running anything', () => {
    const f = stubFetch();
    const offer = mount(f);
    offer.offer('m-1');
    escape();
    expect(offerEl().hidden).toBe(true);
    offer.offer('m-2');
    // A press on the scrim itself, not one inside the card.
    offerEl()
      .querySelector('.cleanup-offer-card')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(offerEl().hidden).toBe(false);
    offerEl().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(offerEl().hidden).toBe(true);
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
    await vi.waitFor(() => expect(noteEl().textContent).toBe('no transcript'));
    // Still pressable, and still refusable: a refusal is not a dead end.
    expect(offerEl().hidden).toBe(false);
    expect(goEl().disabled).toBe(false);
    expect(dismissEl().disabled).toBe(false);
  });

  it('withdraws when the next recording starts, and dismisses on request', () => {
    const f = stubFetch();
    const offer = mount(f);
    offer.offer('m-1');
    offer.withdraw();
    expect(offerEl().hidden).toBe(true);
    offer.offer('m-2');
    dismissEl().click();
    expect(offerEl().hidden).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it('stays gone when the next recording starts mid-request', async () => {
    // The offer is about the meeting that ended. Withdrawing it has to take
    // effect at once: left on screen, the button would tidy the PREVIOUS
    // meeting in the middle of the one now recording.
    const f = deferredFetch();
    const offer = mount(f.impl);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    offer.withdraw();
    expect(offerEl().hidden).toBe(true);
    f.settle(0, { ok: false, error: 'no transcript' }, 500);
    await vi.waitFor(() => expect(f.read(0)).toBe(true));
    expect(offerEl().hidden).toBe(true);
    expect(goEl().disabled).toBe(true);
  });

  it('says nothing at all once the offer has moved to the next meeting', async () => {
    // Two things, and both are about the LAST meeting's request still being
    // on the wire: the new offer's button has to work right now rather than
    // look live and do nothing, and the old request finishing must not take
    // the new offer off the screen with it.
    const f = deferredFetch();
    const offer = mount(f.impl);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    offer.withdraw();
    offer.offer('m-2');
    expect(offerEl().hidden).toBe(false);
    // Pressed while m-1's POST has still not answered: a different meeting,
    // so it goes.
    goEl().click();
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(f.calls[1]?.url).toContain('m-2');
    // And m-1 succeeding now says nothing about m-2's offer.
    f.settle(0, { ok: true, touched: 2 });
    await vi.waitFor(() => expect(f.read(0)).toBe(true));
    expect(offerEl().hidden).toBe(false);
  });

  it("puts no error from the old meeting on the new meeting's offer", async () => {
    const f = deferredFetch();
    const offer = mount(f.impl);
    offer.offer('m-1');
    goEl().click();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    offer.withdraw();
    offer.offer('m-2');
    f.reject(0);
    await vi.waitFor(() => expect(f.read(0)).toBe(true));
    expect(offerEl().hidden).toBe(false);
    expect(noteEl().hidden).toBe(true);
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
