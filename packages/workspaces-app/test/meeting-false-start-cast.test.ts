/**
 * The last meeting's SPEAKER NAMES against a recording that never began.
 *
 * Sibling of `meeting-tidy-offer-false-start.test.ts`, which fixed the other
 * half of the same fault: that one proved the tidy-up offer survives a Record
 * press the browser refuses, and said in as many words that the cast did not.
 * The reset at the top of `start` emptied `names`, `seen` and `lastMeetingId`
 * before the microphone was ever asked for, so a denied press left the person
 * with no voices to rename and no meeting to address the rename to — one
 * mis-tap and a name typed a moment later had nowhere to land.
 *
 * NOTHING HERE CALLS THE RESET. The denial is driven through the code that
 * asks for the microphone — the real `startMeetingCapture` over a `getMedia`
 * that rejects the way a browser rejects a refused prompt — into the real
 * `start`. What is asserted is the cast on screen afterwards and where a
 * rename actually goes.
 *
 * BOTH DIRECTIONS ARE HERE ON PURPOSE. A microphone that DOES open is a new
 * meeting whose cast is not the old one's, so the second case fails any
 * "fix" that simply keeps the names forever.
 *
 * Fictional names throughout; the repo is public.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { startMeetingCapture } from '../src/meeting-audio.ts';
import { type MeetingSocket, mountMeetingStrip } from '../src/meeting-strip.ts';
import type { OriginFacts } from '../src/voice-capture.ts';

const SECURE: OriginFacts = {
  isSecureContext: true,
  protocol: 'https:',
  hostname: 'example.test',
  port: '',
  pathname: '/workspaces/w-riverbend/docs/d-saltmarsh',
  search: '',
};

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

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.replaceChildren();
});

function rig() {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const sockets: FakeSocket[] = [];
  const mic = { allow: true };
  /** Every rename that reached the post-meeting HTTP channel, in order. */
  const posted: Array<[string, string, string]> = [];

  const strip = mountMeetingStrip({
    docId: 'd-saltmarsh',
    root,
    // Alone on the doc, so a Record press is the whole start gesture.
    alone: () => true,
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
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
            Promise.resolve({ sampleRate: 48_000, onBlock: null, stop: () => {} } as never),
        },
      }),
    postName: (meetingId, speaker, name) => {
      posted.push([meetingId, speaker, name]);
      return Promise.resolve(true);
    },
  });
  cleanups.push(() => strip.destroy());

  const record = (): HTMLButtonElement =>
    document.querySelector('.meeting-record') as HTMLButtonElement;
  const chevron = (): HTMLButtonElement =>
    document.querySelector('.meeting-record-options') as HTMLButtonElement;
  /** The rename rows currently on the popover, by the name each one shows. */
  const castRows = (): string[] => {
    chevron().click();
    const rows = [...document.querySelectorAll('.meeting-pop-speaker-name')].map(
      (el) => el.textContent ?? '',
    );
    chevron().click();
    return rows;
  };
  return { root, sockets, mic, posted, strip, record, castRows };
}

/** One meeting, with one voice in it, run to its end. */
async function meetingWithOneVoice(r: ReturnType<typeof rig>): Promise<void> {
  r.record().click();
  await settle();
  const sock = r.sockets[r.sockets.length - 1];
  sock?.onopen?.();
  sock?.serve({ type: 'ready', meetingId: 'm-riverbend-1', startedAt: 1_000, engine: 'test' });
  sock?.serve({ type: 'transcript', turn: 1, text: 'Shall we begin?', final: true, speaker: 'A' });
  sock?.serve({ type: 'stopped', meetingId: 'm-riverbend-1', endedAt: 2_000 });
}

describe('a Record press the browser refuses', () => {
  it('leaves the last meeting’s cast nameable, and the rename lands on that meeting', async () => {
    const r = rig();
    await meetingWithOneVoice(r);
    expect(r.castRows()).toEqual(['Speaker A']);

    // One press of Record, and the browser says no.
    r.mic.allow = false;
    r.record().click();
    await settle();
    expect(r.root.dataset.state).toBe('blocked');

    // The recording never began, so the voice from the last one is still
    // there to be named — and the name goes to the meeting it was spoken in.
    expect(r.castRows()).toEqual(['Speaker A']);
    await expect(r.strip.renameSpeaker('A', 'Devi Raman')).resolves.toBe(true);
    expect(r.posted).toEqual([['m-riverbend-1', 'A', 'Devi Raman']]);
    expect(r.castRows()).toEqual(['Devi Raman']);
  });

  it('still clears them once a microphone actually opens', async () => {
    const r = rig();
    await meetingWithOneVoice(r);
    expect(r.castRows()).toEqual(['Speaker A']);

    // A press that IS granted: a new meeting, whose cast is nobody yet.
    r.record().click();
    await settle();
    expect(r.root.dataset.state).toBe('requesting');
    expect(r.castRows()).toEqual([]);
    // And no meeting for a late rename to be addressed to: this one has not
    // been named by the server, and the last one is over and gone.
    await expect(r.strip.renameSpeaker('A', 'Harborlight Chair')).resolves.toBe(false);
    expect(r.posted).toEqual([]);
  });
});
