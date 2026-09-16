/**
 * The shared fixture for the tidy-up offer's two test files.
 *
 * SPLIT OUT RATHER THAN DUPLICATED. The dialog is asked two different
 * questions — does anything happen without a press
 * (`meeting-cleanup-offer.test.ts`), and does a pass that changed nothing say
 * why (`meeting-cleanup-report.test.ts`) — and both need the same mount, the
 * same accessors and the same two fetches. A second copy of them would be a
 * second thing to keep in step with the dialog's markup.
 *
 * It reads no source file and asserts nothing about one: everything here
 * builds a DOM or answers a request.
 *
 * Fictional names throughout; the repo is public.
 */

import { afterEach, beforeEach, vi } from 'vitest';
import { mountMeetingCleanupOffer } from '../src/meeting-cleanup-offer.ts';

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

export const offerEl = (): HTMLElement => {
  const el = parent.querySelector<HTMLElement>('.cleanup-offer');
  if (!el) throw new Error('no .cleanup-offer rendered');
  return el;
};
export const goEl = (): HTMLButtonElement => {
  const el = offerEl().querySelector<HTMLButtonElement>('.cleanup-offer-go');
  if (!el) throw new Error('no button');
  return el;
};
export const dismissEl = (): HTMLButtonElement => {
  const el = offerEl().querySelector<HTMLButtonElement>('.cleanup-offer-dismiss');
  if (!el) throw new Error('no dismiss button');
  return el;
};
export const noteEl = (): HTMLElement => {
  const el = offerEl().querySelector<HTMLElement>('.cleanup-offer-note');
  if (!el) throw new Error('no note');
  return el;
};
/** The grouped reasons, as the rows a reader sees. */
export const reasonRows = (): string[] =>
  [...offerEl().querySelectorAll('.cleanup-offer-reasons li')].map((li) => li.textContent ?? '');
export const reasonsEl = (): HTMLElement => {
  const el = offerEl().querySelector<HTMLElement>('.cleanup-offer-reasons');
  if (!el) throw new Error('no reasons list');
  return el;
};
export const recoveryEl = (): HTMLElement => {
  const el = offerEl().querySelector<HTMLElement>('.cleanup-offer-recovery');
  if (!el) throw new Error('no recovery line');
  return el;
};
export const tab = (shiftKey = false): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(ev);
  return ev;
};
export const shiftTab = (): KeyboardEvent => tab(true);
/** Escape, dispatched where a real one lands: the focused control. */
export const escape = (): void => {
  (document.activeElement ?? document).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
};

/** A fetch that records its calls and answers with `reply`. */
export function stubFetch(reply: { status?: number; body?: unknown } = {}): typeof fetch & {
  calls: { url: string; method?: string }[];
} {
  const calls: { url: string; method?: string }[] = [];
  const impl = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init?.method ? { method: init.method } : {}) });
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? { ok: true, changed: true, touched: 2 }), {
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
export function deferredFetch(): {
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

export const mount = (fetchImpl: typeof fetch, liveZone?: { holdWash: (ms: number) => void }) => {
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
