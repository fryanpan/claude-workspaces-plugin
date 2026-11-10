/**
 * A meeting's notes take comments the way every other doc does.
 *
 * Bryan, 2026-11-09: remove the "Make a plan" and "Review" buttons at the
 * bottom right of meeting-notes docs ("They're really confusing"), and bring
 * back the comment button on a selection there and on plan docs. Before
 * this, a huddle doc routed a range selection to a separate pointer pill and
 * kept the round comment button hidden, and the two floats sat in the pane.
 *
 * Driven through the real boot (`bootApp`) against the shipped shell, the
 * way app-boot.test.ts does, so what is asserted is the page a reader gets
 * for a doc whose record says it is a meeting's notes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prose } from '@claude-workspaces/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootApp } from '../src/app.ts';
import {
  type FakeServer,
  fakeLocation,
  fakeSockets,
  fakeStorage,
  installFakeBeacon,
  installFakeEventSource,
  installFakeServer,
  settle,
} from './boot-harness.ts';

const server: FakeServer = installFakeServer();
installFakeEventSource();
installFakeBeacon();

const WS = 'w-1';

const SHELL = (() => {
  const html = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('>', html.indexOf('<body')) + 1;
  return html.slice(start, html.indexOf('</body>')).replace(/<script\b[\s\S]*?<\/script>/g, '');
})();

const booted: Array<() => void> = [];

beforeAll(async () => {
  await import('../src/doc/markdown-mount.ts');
}, 60_000);

beforeEach(() => {
  server.reset();
  server.on('/api/auth/session', { authenticated: false, canWrite: true });
});

afterEach(() => {
  for (const stop of booted.splice(0)) stop();
  document.body.innerHTML = '';
  document.body.className = '';
  history.replaceState(null, '', '/');
});

/** Open `d-notes` with `meta` as its record, its prose already on the
 *  server, and wait for the editor to mount. */
async function openDoc(meta: Record<string, unknown>): Promise<void> {
  server.on(`/workspaces/${WS}/docs/`, { meta: { relPath: 'notes.md', ...meta }, tasks: [] });
  const url = `https://docs.test/workspaces/${WS}/docs/d-notes`;
  document.body.innerHTML = SHELL;
  history.replaceState(null, '', new URL(url).pathname);
  const sockets = fakeSockets();
  booted.push(
    await bootApp({
      document,
      location: fakeLocation(url),
      localStorage: fakeStorage({ 'feedback-user-name': 'Alice' }),
      window: new EventTarget(),
      connect: sockets.connect,
    }),
  );
  await settle();
  const client = sockets.first();
  prose
    .getProseFragment(client.ydoc)
    .push(prose.parseMarkdownBlocks('Riverbend needs two more boats before the thaw.\n'));
  client.sync();
  await vi.waitFor(
    () => expect(document.querySelector('#editor > .ProseMirror[contenteditable]')).not.toBeNull(),
    { timeout: 5000, interval: 5 },
  );
}

const commentPill = () => document.getElementById('comment-pill') as HTMLElement;

/** Select the prose the way a reader does, then nudge the pill to re-decide
 *  — a scroll of the editor is one of the signals it listens for. */
function selectProse(): void {
  const dom = document.querySelector('#editor > .ProseMirror') as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(dom);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  (document.getElementById('editor') as HTMLElement).dispatchEvent(new Event('scroll'));
}

/** Every button on the page a reader can see, by its text. */
function visibleButtonText(): string[] {
  return [...document.querySelectorAll<HTMLElement>('button')]
    .filter((b) => !b.hidden && !b.closest('[hidden]'))
    .map((b) => (b.textContent ?? '').trim());
}

const MEETING_NOTES = [
  { name: 'a planning meeting', meta: { huddle: true, huddleKind: 'plan' } },
  { name: 'a discussion', meta: { huddle: true, huddleKind: 'discussion' } },
];

describe('a meeting-notes doc', () => {
  for (const { name, meta } of MEETING_NOTES) {
    it(`${name}: shows neither Make Plan nor Review`, async () => {
      await openDoc(meta);
      // Let the floats' record read land and render.
      await settle();
      const shown = visibleButtonText();
      expect(shown.some((t) => /Make Plan|Plan requested/.test(t))).toBe(false);
      expect(shown.some((t) => /^Review/.test(t))).toBe(false);
      expect(document.querySelector('.review-float')).toBeNull();
      // Control: the float row WAS mounted on this doc, so the absence above
      // is the buttons being gone, not a mount that never ran.
      expect(document.querySelector('#editor-pane .doc-floats .plan-float')).not.toBeNull();
    });

    it(`${name}: selecting text shows the comment button`, async () => {
      await openDoc(meta);
      // Control: nothing selected, no pill.
      expect(commentPill().classList.contains('hidden')).toBe(true);
      selectProse();
      expect(commentPill().classList.contains('hidden')).toBe(false);
      expect(document.querySelector('.pointer-pill')).toBeNull();
    });
  }
});
