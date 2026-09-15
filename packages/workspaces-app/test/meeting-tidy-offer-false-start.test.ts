/**
 * The tidy-up offer against a RECORDING THAT NEVER BEGAN.
 *
 * The strip and the offer are mounted here the way `doc/doc-meeting-mount.ts`
 * mounts them — `onMeetingChange(null)` withdraws, `onMeetingEnded` offers —
 * because the defect is in the seam between them and neither module can show
 * it alone: the strip announced "a new meeting, id unknown" from the first
 * line of the Record press, before it had asked for a microphone, so a press
 * the browser then refused took the LAST meeting's offer off the screen for
 * good. A person who mis-tapped Record, or whose microphone was denied, lost
 * the tidy-up for the meeting he had just finished, with no way back to it.
 *
 * NOTHING HERE CALLS `withdraw`. The denial is driven through the code that
 * asks for the microphone: the real `startMeetingCapture` over a `getMedia`
 * that rejects the way a browser rejects a refused permission prompt, through
 * the real capture set, into the real `start`. What is asserted is what is on
 * screen afterwards.
 *
 * Fictional names throughout; the repo is public.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { startMeetingCapture } from '../src/meeting-audio.ts';
import { mountMeetingCleanupOffer } from '../src/meeting-cleanup-offer.ts';
import { type MeetingSocket, mountMeetingStrip } from '../src/meeting-strip.ts';
import type { OriginFacts } from '../src/voice-capture.ts';

const SECURE: OriginFacts = {
  isSecureContext: true,
  protocol: 'https:',
  hostname: 'example.test',
  port: '',
  pathname: '/workspaces/w-harbor/docs/d-quay',
  search: '',
};

/** The socket the strip opens; every frame it receives comes from the case. */
class FakeSocket implements MeetingSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void {}
  serve(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

/** A microphone the browser hands over, and one it refuses. */
const GRANTED = { allow: true };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.replaceChildren();
});

function rig() {
  document.body.replaceChildren();
  const root = document.createElement('div');
  // The dialog's own parent: the strip owns the element it is mounted on and
  // rebuilds its children, so the offer lives beside it exactly as it does on
  // the real page (where it is appended to the body).
  const dialogHome = document.createElement('div');
  document.body.append(root, dialogHome);
  const sockets: FakeSocket[] = [];
  const stopped: number[] = [];
  const mic = { ...GRANTED };

  const offer = mountMeetingCleanupOffer({ docId: 'd-quay', parent: dialogHome });
  cleanups.push(() => offer.destroy());

  const strip = mountMeetingStrip({
    docId: 'd-quay',
    root,
    // Alone on the doc, so a Record press is the whole start gesture and the
    // chooser never opens — the shortest path to the press this is about.
    alone: () => true,
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    // The real capture, over a device the case decides about. A refusal
    // arrives as `NotAllowedError`, which is what a browser raises for a
    // denied prompt and for a prompt the person dismissed.
    startCapture: (o) =>
      startMeetingCapture({
        ...o,
        deps: {
          readOrigin: () => SECURE,
          getMedia: () =>
            mic.allow
              ? Promise.resolve({
                  getTracks: () => [],
                  getAudioTracks: () => [],
                  getVideoTracks: () => [],
                  removeTrack: () => {},
                } as unknown as MediaStream)
              : Promise.reject(
                  Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
                ),
          createPump: () =>
            Promise.resolve({
              sampleRate: 48_000,
              onBlock: null,
              stop: () => stopped.push(1),
            } as never),
        },
      }),
    // Exactly the wiring `doc-meeting-mount.ts` gives them.
    onMeetingChange: (meetingId) => {
      if (meetingId === null) offer.withdraw();
    },
    onMeetingEnded: (meetingId) => offer.offer(meetingId),
  });
  cleanups.push(() => strip.destroy());

  const record = (): HTMLButtonElement =>
    document.querySelector('.meeting-record') as HTMLButtonElement;
  const offerEl = (): HTMLElement => {
    const el = dialogHome.querySelector<HTMLElement>('.cleanup-offer');
    if (!el) throw new Error('no .cleanup-offer rendered');
    return el;
  };
  return { root, sockets, mic, record, offerEl, note: () => root.querySelector('.meeting-note') };
}

describe('a recording that never started', () => {
  it('leaves the last meeting’s tidy-up offer on screen when the microphone is refused', async () => {
    const r = rig();

    // A meeting happens, and ends: the offer to tidy it is up.
    r.record().click();
    await settle();
    r.sockets[0]?.onopen?.();
    r.sockets[0]?.serve({ type: 'ready', meetingId: 'm-quay-1', startedAt: 1_000, engine: 'test' });
    r.sockets[0]?.serve({ type: 'stopped', meetingId: 'm-quay-1', endedAt: 2_000 });
    expect(r.offerEl().hidden).toBe(false);

    // One press of Record, and the browser says no.
    r.mic.allow = false;
    r.record().click();
    await settle();

    // The recording never began — so the offer is still the offer to make.
    expect(r.root.dataset.state).toBe('blocked');
    expect(r.offerEl().hidden).toBe(false);
  });

  it('withdraws the old offer once a recording actually starts', async () => {
    const r = rig();
    r.record().click();
    await settle();
    r.sockets[0]?.onopen?.();
    r.sockets[0]?.serve({ type: 'ready', meetingId: 'm-quay-1', startedAt: 1_000, engine: 'test' });
    r.sockets[0]?.serve({ type: 'stopped', meetingId: 'm-quay-1', endedAt: 2_000 });
    expect(r.offerEl().hidden).toBe(false);

    // The other half of the same rule: a microphone that DOES open is a new
    // meeting, and an offer to tidy the last one is no longer the offer to
    // make. Guarding the withdrawal must not cost us this.
    r.record().click();
    await settle();
    // Gone the moment the microphone opens, not when the server names the
    // meeting: the notes behind the dialog are about to be written into.
    expect(r.root.dataset.state).toBe('requesting');
    expect(r.offerEl().hidden).toBe(true);
    r.sockets[1]?.onopen?.();
    r.sockets[1]?.serve({ type: 'ready', meetingId: 'm-quay-2', startedAt: 3_000, engine: 'test' });
    expect(r.root.dataset.state).toBe('recording');
    expect(r.offerEl().hidden).toBe(true);
  });
});
