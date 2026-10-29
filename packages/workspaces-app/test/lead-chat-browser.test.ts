/**
 * The lead chat on every surface it ships on — the board, its Home, a doc and
 * a mock — at 1180x820 and 430x932: a tap opens the chat, a typed message
 * reaches the board's lead, and its answer appears in the already-open panel.
 * In Voice first the bar comes out attached to the button and a heard line
 * reaches the lead marked as said. `lead-chat-browser-driver.ts` does it in
 * headless Chromium against a real server; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { LeadChatRun } from './lead-chat-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-browser-driver.ts');
/** Two bundle builds, two launches, ten page loads. */
const SUITE_MS = 260_000;
const SPAWN_MS = 250_000;

let run: LeadChatRun | null = null;
const result = (): LeadChatRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('the lead chat in a browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as LeadChatRun;
  }, SUITE_MS);

  it('reaches the lead and shows its answer on the board, Home, a doc and a mock, at both sizes', () => {
    const { surfaces } = result();
    expect(surfaces.map((s) => `${s.surface}@${s.width}`)).toEqual([
      'board@1180',
      'home@1180',
      'doc@1180',
      'mock@1180',
      'board@430',
      'home@430',
      'doc@430',
      'mock@430',
    ]);
    for (const s of surfaces) {
      const at = `${s.surface}@${s.width}`;
      expect(s.leadHeard, at).toBe(`What is left on the ${s.surface} at ${s.width}?`);
      expect(s.answerShown, at).toBe(true);
      expect(s.composerFocused, at).toBe(true);
      expect(s.closedAfter, at).toBe(true);
      expect(s.context, at).toBe(s.surface === 'doc' || s.surface === 'mock' ? 'doc' : 'board');
    }
  });

  it('keeps the agent button reachable, and the same size and place when the chat opens', () => {
    for (const s of result().surfaces) {
      const at = `${s.surface}@${s.width}`;
      expect(s.buttonOnTop, at).toBe(true);
      expect(s.buttonOpen, at).toEqual(s.buttonBefore);
      expect(s.buttonBefore?.width, at).toBe(44);
    }
  });

  it('draws the panel inside the screen, and as a full-width sheet on a phone', () => {
    for (const s of result().surfaces) {
      const at = `${s.surface}@${s.width}`;
      const p = s.pane;
      expect(p, at).not.toBeNull();
      if (!p) continue;
      expect(p.left, at).toBeGreaterThanOrEqual(0);
      expect(p.top, at).toBeGreaterThanOrEqual(0);
      expect(p.left + p.width, at).toBeLessThanOrEqual(s.viewport.width);
      expect(p.top + p.height, at).toBeLessThanOrEqual(s.viewport.height);
      if (s.width === 430) expect(p.width, at).toBe(s.viewport.width);
      else expect(p.width, at).toBeLessThanOrEqual(440);
    }
  });

  it('Voice first, chosen in Settings: the bar comes out of the button, and a heard line reaches the lead as said', () => {
    const { voice } = result();
    expect(voice.map((v) => v.width)).toEqual([1180, 430]);
    for (const v of voice) {
      const at = String(v.width);
      const { bar, button } = v;
      expect(bar && button, at).toBeTruthy();
      if (!bar || !button) continue;
      if (v.width === 1180) {
        expect(bar.top, at).toBe(button.top);
        expect(bar.height, at).toBe(button.height);
        expect(bar.left, at).toBeGreaterThanOrEqual(button.left + button.width);
        expect(bar.left + bar.width, at).toBeLessThanOrEqual(v.viewport.width - 8);
      } else {
        expect(bar.left, at).toBe(8);
        expect(bar.left + bar.width, at).toBeLessThanOrEqual(v.viewport.width - 8);
        expect(bar.top + bar.height, at).toBeLessThanOrEqual(button.top);
      }
      expect(v.settingsDefault, at).toBe('chat');
      expect(v.settingsStored, at).toBe('voice');
      expect(v.recognitionStarts, at).toBe(1);
      expect(v.leadHeard, at).toBe(`Read me the next one at ${v.width}`);
      expect(v.storedVia, at).toBe('voice');
      expect(v.barGone, at).toBe(true);
      expect(v.recognitionStops, at).toBe(1);
    }
  });
});
