import { expect, vi } from 'vitest';
import type { VoiceComment, VoiceSession } from '../src/voice/voice-session.ts';
import { VoiceView } from '../src/voice/voice-ui.ts';

/**
 * A view over a session that is state alone — the fields the view reads, set
 * by each test — and `setResolved` and `reopen` recorded. Shared by the view's two suites.
 */

export interface FakeSession {
  state: VoiceSession['state'];
  comments: Map<string, VoiceComment>;
  heard: string;
  pending: string;
  recording: number;
  pinned: number | null | undefined;
  note: string | null;
  setResolved: ReturnType<typeof vi.fn>;
  reopen: ReturnType<typeof vi.fn>;
}

export const CLIP = '/workspaces/w-1/docs/d-1/voice-feedback/seg-1.wav#t=12.4,31';

export function comment(over: Partial<VoiceComment> = {}): VoiceComment {
  return {
    key: 'v1',
    wire: 'v1',
    take: 1,
    text: 'The goal bar is too tall.',
    raw: 'um the goal bar is like too tall',
    clip: CLIP,
    target: null,
    final: false,
    ...over,
  };
}

export function setup() {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  const goal = document.createElement('div');
  document.body.append(goal);
  const elements = new Map<number, HTMLElement>([[2, goal]]);
  const session: FakeSession = {
    state: 'recording',
    comments: new Map(),
    heard: '',
    pending: '',
    recording: 1,
    pinned: undefined,
    note: null,
    setResolved: vi.fn(async () => {}),
    reopen: vi.fn(),
  };
  const moved: string[] = [];
  let now = 1_000;
  const view = new VoiceView({
    session: session as unknown as VoiceSession,
    shadow,
    element: (t) => (t === null ? null : (elements.get(t) ?? null)),
    name: (t) => (t === 2 ? 'Goal bar' : `#${t}`),
    clipAudio: async (clip) => new Audio(`http://host${clip}`),
    onMove: (key) => moved.push(key),
    now: () => now,
  });
  const add = (c: VoiceComment) => {
    session.comments.set(c.key, c);
    view.render();
  };
  const card = (key = 'v1') =>
    shadow.querySelector(`.vcard[data-key="${key}"]`) as HTMLElement | null;
  const where = () => view.live.querySelector('.vwhere') as HTMLElement;
  return {
    view,
    session,
    shadow,
    elements,
    moved,
    add,
    card,
    where,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** An element on the page standing at `top`..`bottom`, 600px wide from the left. */
export function rowAt(top: number, bottom: number): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 24, y: top, width: 600, height: bottom - top }),
  );
  return el;
}

/** The page is 1180x820 or 430x932. */
export function screen(width: number, height: number): void {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(height);
  // The test DOM has no visual viewport, so the window is the screen.
  expect(window.visualViewport ?? null).toBeNull();
}

/** A card is 130px tall, 260px with its raw words open; the live card 150px. */
export function heights(): void {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('vlive')) return 150;
    return this.querySelector('.vrawtext:not([hidden])') ? 260 : 130;
  });
}

export const box = (el: HTMLElement | null) => {
  const top = Number.parseFloat(el?.style.top ?? '');
  return { top, bottom: top + (el?.offsetHeight ?? 0) };
};
