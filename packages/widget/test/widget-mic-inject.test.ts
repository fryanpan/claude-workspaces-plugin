import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountEmbedMic } from '../src/mic-entry.ts';
import { injectMic } from '../src/widget-mic-inject.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * The microphone on a page that only dropped in the tag and the script.
 *
 * Voice feedback was reachable from exactly two places, both ours — a mock the
 * workspace serves, and the board — so an embed on somebody else's dev server
 * had every path below the button open and no button to hold. These are the
 * few bytes in the budgeted bundle that fetch it, and the chunk they fetch.
 *
 * The two ways this can go wrong are both about the pages that ALREADY have a
 * mic: a served mock loads `mockup-live.js` beside the widget, and the board
 * mounts its own. A second mount does not replace the first — `addMic` hands
 * the same button back — it arms the first tap a second time, which is two
 * AudioContexts, two sockets and two live comments for one sentence.
 */

const SERVER = 'ws://feedback.example:8787';

/** The widget's shell, as `renderShell` leaves the parts the mic reaches. */
function embed(opts: { serverUrl?: string; withMic?: boolean } = {}): FeedbackWidgetEl {
  const host = document.createElement('claude-feedback-widget');
  const shadow = host.attachShadow({ mode: 'open' });
  const list = document.createElement('button');
  list.className = 'fab-list';
  const fab = document.createElement('button');
  fab.className = 'fab';
  shadow.append(list, fab);
  if (opts.withMic) {
    const mic = document.createElement('button');
    mic.className = 'fab-list fab-mic';
    shadow.append(mic);
  }
  document.body.append(host);
  return Object.assign(host, {
    shadow,
    opts: { serverUrl: opts.serverUrl ?? SERVER, workspaceId: 'w-riverbend', docId: 'page-1' },
  }) as unknown as FeedbackWidgetEl;
}

const injected = (): string[] =>
  [...document.head.querySelectorAll('script')].map((s) => s.getAttribute('src') ?? '');

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  window.cwMic = undefined;
  window.cwVoice = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the bundle every embed loads fetches the mic', () => {
  it('appends the mic chunk from the server the widget was given', () => {
    embed();
    expect(injectMic(document), 'it says it injected').toBe(true);
    // The server the widget talks to, not the page's own origin: the widget
    // is a guest, and the page it sits on serves none of this.
    expect(injected()).toEqual(['http://feedback.example:8787/widget/mic.js']);
    expect(window.cwMic, 'and says so, so a second widget adds no second tag').toBe(true);
  });

  it('adds nothing on a page whose bundle will mount a mic itself', () => {
    // A served mock: `voice/voice-loader.ts` sets this at module scope, while
    // the page is still parsing, so it is already true by the time this runs
    // however the two script tags were ordered.
    embed();
    window.cwMic = true;
    expect(injectMic(document)).toBe(false);
    expect(injected()).toEqual([]);
  });

  it('adds nothing on a page that already has one up', () => {
    embed({ withMic: true });
    expect(injectMic(document)).toBe(false);
    expect(injected()).toEqual([]);
  });

  it('adds nothing for a widget that never initialised', () => {
    // No `server-url` and no `doc-id` is a misconfigured embed, which `init`
    // is what complains about; a mic would have nowhere to send a recording.
    embed({ serverUrl: '' });
    expect(injectMic(document)).toBe(false);
    expect(injected()).toEqual([]);
  });

  it('adds nothing on a page with no widget at all', () => {
    expect(injectMic(document)).toBe(false);
    expect(injected()).toEqual([]);
  });
});

describe('the chunk it fetches', () => {
  /** A voice chunk already on the window, so the first tap resolves without a
   *  network fetch. Counts what a tap asked for. */
  function stubVoice(): { mounts: number; toggles: number } {
    const counts = { mounts: 0, toggles: 0 };
    window.cwVoice = {
      mountVoiceMode: () => {
        counts.mounts += 1;
        return {
          toggle: () => {
            counts.toggles += 1;
          },
        } as unknown as ReturnType<NonNullable<Window['cwVoice']>['mountVoiceMode']>;
      },
    };
    return counts;
  }

  it('puts a mic on a bare embed, labelled for the page it is a guest on', () => {
    const el = embed();
    mountEmbedMic(document);
    const mic = el.shadow.querySelector('.fab-mic') as HTMLElement;
    expect(mic, 'a mic button').toBeTruthy();
    // "this page", never "this mock": the embed is on somebody else's dev
    // server and a mock's wording would be a lie there.
    expect(mic.dataset.tip).toBe('Talk: voice feedback on this page');
    expect(el.shadow.querySelector('.readout'), 'and somewhere to answer').toBeTruthy();
  });

  it('arms the first tap once when a page mounts twice, not twice', async () => {
    const el = embed();
    const counts = stubVoice();
    mountEmbedMic(document);
    mountEmbedMic(document);
    const mics = el.shadow.querySelectorAll('.fab-mic');
    expect(mics.length, 'one button').toBe(1);
    (mics[0] as HTMLElement).click();
    // One tap, one mode: a second arming would have opened a second socket
    // and posted a second live comment for the same sentence.
    await vi.waitFor(() => expect(counts.mounts).toBe(1));
    expect(counts.toggles, 'and started recording once').toBe(1);
  });

  it('CONTROL: one mount does arm the tap, so the case above can fail', async () => {
    const el = embed();
    const counts = stubVoice();
    mountEmbedMic(document);
    (el.shadow.querySelector('.fab-mic') as HTMLElement).click();
    await vi.waitFor(() => expect(counts.mounts).toBe(1));
  });
});
