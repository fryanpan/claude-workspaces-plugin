/**
 * In comment mode a press on an app's clickable row is a comment, and only
 * that. With the mode off it is the app's.
 *
 * THE REPORT. On an attached app, rows that are links or that open a panel
 * could not be commented on, and the guess was that the click went to the app
 * instead. Measured on the base commit with a real mouse, the composer did
 * open, AND the app's click handler ran: the mode cancelled the click's
 * default, which stops a plain link, and left the click travelling, so a
 * row's handler and a client-side router both ran behind the composer. A
 * finger was already safe, because a cancelled touchend makes no click.
 *
 * The first describe runs everywhere, so a local `bun run verify` holds the
 * property. The second presses a real page in a real browser, because which
 * listeners a browser's press reaches is the behaviour itself.
 *
 * audit: no-text — the driver measures a running browser; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { enterFeedbackMode, exitFeedbackMode } from '../src/widget-picker.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';
import { type Pointer, type Press, type Reading, TARGETS } from './comment-click-driver-types.ts';

const CHROME = chromeForSuite();
const DRIVER = join(import.meta.dirname, 'comment-click-driver.ts');

/** The composer's subject for each target, in the driver's invented app. */
const WORDS: Record<(typeof TARGETS)[number], string> = {
  link: 'Riverbend invoice',
  routed: 'Saltmarsh invoice',
  direct: "Alice's order",
  delegated: "Bob's order",
  pressed: "Harborlight's order",
};

async function mount(): Promise<FeedbackWidgetEl> {
  (globalThis as unknown as { fetch: unknown }).fetch = (async () =>
    new Response('{}', {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  class FakeWS {
    static OPEN = 1;
    readyState = 1;
    binaryType = 'arraybuffer';
    addEventListener(): void {}
    removeEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
  const mod = await import('../src/widget.ts');
  return mod.FeedbackWidget.init({ workspaceId: 'w-1', docId: 'd-click', user: 'Alice' });
}

describe('a press on a clickable element', () => {
  let el: FeedbackWidgetEl;
  let ran: string[];
  let onDocument: EventListener;

  /** The sequence a mouse makes, delivered to the element itself. */
  const press = (id: string): boolean => {
    const target = document.getElementById(id) as HTMLElement;
    (
      document as unknown as { elementFromPoint: (x: number, y: number) => Element }
    ).elementFromPoint = () => target;
    const at = { clientX: 40, clientY: 40, bubbles: true, cancelable: true, composed: true };
    for (const type of ['pointerdown', 'pointerup']) {
      target.dispatchEvent(new PointerEvent(type, at));
    }
    return target.dispatchEvent(new MouseEvent('click', at));
  };
  const composer = (): Element | null => el.shadow.querySelector('.composer');

  beforeEach(async () => {
    document.body.innerHTML =
      '<a id="link" href="#away">Riverbend invoice</a>' +
      '<div id="direct">Alice\'s order</div>' +
      '<div id="delegated" data-open>Bob\'s order</div>';
    ran = [];
    document.getElementById('link')?.addEventListener('click', () => ran.push('link'));
    document.getElementById('direct')?.addEventListener('click', () => ran.push('direct'));
    onDocument = (ev) => {
      if ((ev.target as Element).closest('[data-open]')) ran.push('delegated');
    };
    document.addEventListener('click', onDocument);
    el = await mount();
  });

  afterEach(() => {
    exitFeedbackMode(el);
    document.removeEventListener('click', onDocument);
    el.remove();
    document.body.innerHTML = '';
  });

  it.each(['link', 'direct', 'delegated'])('%s: mode on, a comment and no handler', (id) => {
    enterFeedbackMode(el);
    expect(press(id)).toBe(false); // The default is cancelled too.
    expect(composer()).not.toBeNull();
    expect(ran).toEqual([]);
  });

  it.each(['link', 'direct', 'delegated'])('%s: mode off, the handler and no comment', (id) => {
    expect(press(id)).toBe(true);
    expect(composer()).toBeNull();
    expect(ran).toEqual([id]);
  });

  it.each(['link', 'direct', 'delegated'])('%s: mode left, the handler again', (id) => {
    enterFeedbackMode(el);
    exitFeedbackMode(el);
    expect(press(id)).toBe(true);
    expect(ran).toEqual([id]);
  });
});

describe.skipIf(CHROME === null)('real presses on an app', () => {
  let readings: Reading[] = [];
  const of = (pointer: Pointer): Reading => {
    const r = readings.find((x) => x.pointer === pointer);
    if (!r) throw new Error(`no reading for ${pointer}`);
    return r;
  };

  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: 170_000 });
    expect(r.status, r.stderr).toBe(0);
    readings = JSON.parse(r.stdout) as Reading[];
  }, 180_000);

  /** Every handler the app bound for that target, with the mode off. */
  const appAnswers = (p: Press, t: (typeof TARGETS)[number]): void => {
    expect(p.subject).toBeNull();
    if (t === 'link') expect(p.hash).toBe('#opened');
    if (t === 'routed') expect(p.ran).toEqual(['router']);
    if (t === 'direct' || t === 'delegated') expect(p.ran).toEqual([t]);
    if (t === 'pressed') expect(p.ran).toContain('mouseup');
  };

  for (const pointer of ['mouse', 'finger'] as const) {
    for (const t of TARGETS) {
      it(`${pointer} on ${t}: the app's before the mode and after it, a comment during`, () => {
        const r = of(pointer);
        expect([r.armed, r.left]).toEqual([true, true]);
        appAnswers(r.off[t], t);
        expect(r.on[t]).toEqual({ ran: [], hash: '', subject: WORDS[t] });
        appAnswers(r.after[t], t);
      });
    }
  }
});
