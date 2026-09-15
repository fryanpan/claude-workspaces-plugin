import type { Anchor } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../src/voice/voice-session.ts';
import { FakeSocket, commentFrame, fakeMic, recordingPoster } from './voice-fakes.ts';
import { comment, setup as viewSetup } from './voice-ui-harness.ts';

/**
 * Finished notes on the page: the words said since the last pause under the
 * note, a tap on an earlier note that adds to it, and a phone's dots marking
 * those notes while talking. The flow is the owner's approved mock; the page
 * is synthetic.
 */

async function recording() {
  const sockets: FakeSocket[] = [];
  const rec = recordingPoster();
  const session = new VoiceSession({
    url: 'ws://host/workspaces/w-1/docs/d-1/voice',
    openSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    startCapture: fakeMic().start,
    poster: rec.poster,
    catalog: () => [],
    anchorFor: (target): Anchor =>
      target === null
        ? { kind: 'subject' }
        : ({ kind: 'element', snippet: { text: `#${target}` } } as unknown as Anchor),
    onChange: () => {},
  });
  const socket = () => sockets.at(-1) as FakeSocket;
  const again = async () => {
    await session.start();
    socket().open();
    socket().recv({ type: 'ready', segment: sockets.length });
  };
  await again();
  return { session, socket, rec, again };
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the session', () => {
  it('keeps the words no note holds yet', async () => {
    const t = await recording();
    t.socket().recv({ type: 'heard', text: 'so the goal bar is tall', pending: 'is tall' });
    expect(t.session.pending).toBe('is tall');
    expect(t.session.heard).toBe('so the goal bar is tall');
  });

  it('a tap on an element with a note from this recording adds to that note', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', target: 1, final: true }));
    t.session.pointAt(1);
    expect(t.socket().json().at(-1)).toEqual({ type: 'reopen', key: 'v1' });
    expect(t.session.comments.get('1.v1')?.reopening).toBe(true);

    t.session.pointAt(2);
    expect(t.socket().json().at(-1), 'CONTROL: an element with no note').toEqual({
      type: 'pin',
      target: 2,
    });
    expect(t.session.comments.get('1.v1')?.reopening, 'the pin replaced it').toBe(false);
    t.socket().recv(commentFrame({ key: 'v2', target: null, final: true }));
    t.session.pointAt(null);
    expect(t.socket().json().at(-1), 'the page as a whole is never a note').toEqual({
      type: 'pin',
      target: null,
    });
  });

  it('a note from an earlier recording starts a new one on its element', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', target: 1, final: true }));
    t.socket().recv({ type: 'stopped' });
    await t.again();
    t.session.reopen('1.v1');
    expect(t.socket().json().at(-1)).toEqual({ type: 'pin', target: 1 });
  });

  it('edits the thread once per finished note, not when a note opens again', async () => {
    const t = await recording();
    t.socket().recv(commentFrame({ key: 'v1', text: 'The goal bar is tall.', final: true }));
    await vi.waitFor(() => expect(t.session.comments.get('1.v1')?.posted).toBeTruthy());
    t.session.reopen('1.v1');
    t.socket().recv(commentFrame({ key: 'v1', text: 'The goal bar is tall.', final: false }));
    expect(t.session.comments.get('1.v1')?.reopening).toBe(false);
    t.socket().recv(
      commentFrame({
        key: 'v1',
        text: 'The goal bar is tall; make it shorter.',
        raw: 'um the goal bar is too tall make it shorter',
      }),
    );
    await vi.waitFor(() => expect(t.rec.calls).toHaveLength(2));
    expect(t.rec.calls.map((c) => c.op)).toEqual(['create', 'edit']);
  });

  it('keeps the pin when the words before the tap made a note elsewhere', async () => {
    const t = await recording();
    t.session.pin(2);
    t.socket().recv(commentFrame({ key: 'v1', target: 1 }));
    expect(t.session.pinned).toBe(2);
    t.socket().recv(commentFrame({ key: 'v2', target: 2 }));
    expect(t.session.pinned, 'CONTROL: spent by the note on it').toBeUndefined();
  });
});

describe('the live card', () => {
  it('shows the words while they come, and the note alone once they are in it', () => {
    const t = viewSetup();
    const cls = (c: string) => t.view.live.classList.contains(c);
    t.session.pending = 'the goal bar is';
    t.view.render();
    expect([cls('hearing'), cls('noted')]).toEqual([true, false]);
    expect(t.view.live.querySelector('.vraw span')?.textContent).toBe('the goal bar is');

    t.session.pending = '';
    t.add(comment({ target: 2 }));
    expect([cls('hearing'), cls('quiet'), cls('noted')]).toEqual([false, true, true]);
    const kept = t.view.live.querySelector('.vkept') as HTMLElement;
    expect(kept.textContent).toBe('“um the goal bar is like too tall”');
    expect(kept.classList.contains('open')).toBe(false);
    (t.view.live.querySelector('.vpol') as HTMLElement).click();
    expect(kept.classList.contains('open'), 'one tap shows the raw words').toBe(true);
    kept.click();
    expect(kept.classList.contains('open')).toBe(false);
  });

  it('a tap on an earlier note’s card while talking adds to it, and after Stop shows its raw words', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1180);
    const t = viewSetup();
    t.add(comment({ key: 'v1', final: true }));
    (t.card('v1')?.querySelector('.vtext') as HTMLElement).click();
    expect(t.session.reopen).toHaveBeenCalledWith('v1');

    t.session.state = 'idle';
    t.view.render();
    (t.card('v1')?.querySelector('.vtext') as HTMLElement).click();
    expect(t.session.reopen).toHaveBeenCalledTimes(1);
    expect((t.card('v1')?.querySelector('.vrawtext') as HTMLElement).hidden).toBe(false);
  });

  it('a note opened again leaves the column for the live card, and comes back when it settles', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1180);
    const t = viewSetup();
    const c = comment({ key: 'v1', final: true, target: 2 });
    t.add(c);
    expect(t.card('v1')).not.toBeNull();
    c.reopening = true;
    t.view.render();
    expect(t.card('v1'), 'no card while it is the note being talked about').toBeNull();
    expect(t.view.live.querySelector('.vpol')?.textContent).toBe(c.text);
    expect(t.view.live.querySelector('.vwhere')?.textContent).toBe('Goal bar');
    c.reopening = false;
    c.final = false;
    t.view.render();
    expect(t.card('v1')).toBeNull();
    c.final = true;
    t.view.render();
    expect(t.card('v1'), 'back once it settles').not.toBeNull();
  });
});

describe('a phone while talking', () => {
  it('marks each earlier note of this recording with a dot on its element, and a tap adds to it', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(430);
    const t = viewSetup();
    const dots = () => [...t.shadow.querySelectorAll<HTMLElement>('.vpin')];
    t.add(comment({ key: 'v1', final: true, target: 2 }));
    t.add(comment({ key: 'v0', take: 0, final: true, target: 2 }));
    t.add(comment({ key: 'v2', final: true, target: 9 }));
    t.view.place();
    expect(
      dots().map((d) => d.dataset.key),
      'not the last recording’s, not one whose element is gone',
    ).toEqual(['v1']);
    expect(dots()[0]?.getAttribute('aria-label')).toBe('Goal bar');
    dots()[0]?.click();
    expect(t.session.reopen).toHaveBeenCalledWith('v1');

    t.session.state = 'idle';
    t.view.render();
    t.view.place();
    expect(dots(), 'none after Stop').toEqual([]);
  });

  it('CONTROL: a wide screen has cards beside the page instead of dots', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1180);
    const t = viewSetup();
    t.add(comment({ key: 'v1', final: true, target: 2 }));
    t.view.place();
    expect(t.shadow.querySelectorAll('.vpin')).toHaveLength(0);
    expect(t.card('v1')?.hidden).toBe(false);
  });
});
