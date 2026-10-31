/**
 * The lead chat's history and markdown in a real browser, at 1180x820 and
 * 430x932: the chat opens on the conversation so far, scrolls back page by
 * page to the first message, draws the lead's markdown with nothing in it
 * run, shows a message sent elsewhere while it is open, and opens on the
 * same conversation after a reload. `lead-chat-history-browser-driver.ts`
 * does it against a real server; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { LEAD_CHAT_PAGE } from '@claude-workspaces/core/lead-chat';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { HISTORY_SIZE, type HistoryRun } from './lead-chat-history-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-history-browser-driver.ts');
/** One bundle build, two launches, four page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: HistoryRun | null = null;
const result = (): HistoryRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('the lead chat history in a browser', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as HistoryRun;
  }, SUITE_MS);

  it('runs at both sizes', () => {
    expect(result().widths.map((w) => w.width)).toEqual([1180, 430]);
  });

  it('opens on the latest page of the conversation so far, newest at the bottom', () => {
    for (const w of result().widths) {
      const at = String(w.width);
      // The 430 run opens after the 1180 run's message from elsewhere.
      const ids = w.firstOpen.ids;
      expect(ids.indexOf('md'), at).toBe(ids.indexOf('mine') + 1);
      expect(ids.indexOf('md'), at).toBeGreaterThanOrEqual(ids.length - 2);
      expect(w.firstOpen.ids.length, at).toBeGreaterThanOrEqual(LEAD_CHAT_PAGE);
      expect(w.firstOpen.history, at).not.toMatch(/^Start of/);
    }
  });

  it('scrolls back page by page to the first message, keeping the reader’s line in place', () => {
    result().widths.forEach((w, i) => {
      const at = String(w.width);
      // The seeded conversation plus one message from elsewhere per run so
      // far; the first open showed a page and that one message.
      const total = HISTORY_SIZE + i + 1;
      expect(w.pages, at).toBe(Math.ceil((total - LEAD_CHAT_PAGE - 1) / LEAD_CHAT_PAGE));
      expect(w.atFirst.ids[0], at).toBe('h0');
      expect(w.atFirst.ids, at).toHaveLength(total);
      expect(new Set(w.atFirst.ids).size, at).toBe(total);
      expect(w.atFirst.history, at).toBe('Start of your conversation with Harborlight Lead');
      for (const d of w.anchorDrift) expect(d, at).toBeLessThanOrEqual(2);
    });
  });

  it('shows a message sent from elsewhere in the open chat within a second', () => {
    for (const w of result().widths) expect(w.liveWithin1s, String(w.width)).toBe(true);
  });

  it('opens on the same conversation after a reload', () => {
    for (const w of result().widths) {
      const at = String(w.width);
      expect(w.reloaded.texts.at(-1), at).toBe(w.elsewhere);
      expect(w.reloaded.ids, at).toContain('md');
      expect(w.reloaded.ids.length, at).toBeGreaterThanOrEqual(LEAD_CHAT_PAGE);
    }
  });

  it('draws the lead’s message as markdown', () => {
    for (const w of result().widths) {
      const at = String(w.width);
      const md = w.markdown;
      expect(md.heading, at).toBe('Saltmarsh plan');
      expect(md.bold, at).toBe('the bold part');
      expect(md.italic, at).toBe('the italic part');
      expect(md.inlineCode, at).toBe('inline code');
      expect(md.bullets, at).toEqual(['first bullet', 'second bullet']);
      expect(md.numbered, at).toEqual(['step one', 'step two']);
      expect(md.tableHead, at).toEqual(['Gate', 'Result']);
      expect(md.tableCells, at).toEqual(['lint', 'pass']);
      expect(md.codeBlock, at).toBe('const riverbend = 1;');
    }
  });

  it('opens the lead’s links, written and bare, in a new tab without an opener', () => {
    for (const w of result().widths) {
      const at = String(w.width);
      expect(w.markdown.links, at).toEqual([
        {
          href: 'https://example.com/pr/1',
          text: 'the pull request',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        {
          href: 'https://example.com/ci/2',
          text: 'https://example.com/ci/2',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      ]);
    }
  });

  it('shows a script tag and an inline handler as text and runs neither', () => {
    for (const w of result().widths) {
      const at = String(w.width);
      const md = w.markdown;
      expect(md.ran, at).toBeNull();
      expect(md.scripts, at).toBe(0);
      expect(md.images, at).toBe(0);
      expect(md.handlers, at).toBe(0);
      expect(md.scriptAsText, at).toBe(true);
    }
  });

  it('keeps the person’s own message as plain text', () => {
    for (const w of result().widths) {
      const at = String(w.width);
      expect(w.markdown.mineTag, at).toBe(0);
      expect(w.markdown.mineText, at).toBe('Is <b>this</b> bold?');
    }
  });
});
