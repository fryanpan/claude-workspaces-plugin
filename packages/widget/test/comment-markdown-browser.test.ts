/**
 * A mock thread's comment written in markdown is drawn rendered in its
 * popover — a link, bold text and a list — and a comment trying a
 * `javascript:` link or a raw `<img onerror>` draws inert, in a real browser.
 *
 * `comment-markdown-driver.ts` drives the page; this file asserts on what it
 * read.
 *
 * audit: no-text — the driver reads a running browser; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Reading } from './comment-markdown-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'comment-markdown-driver.ts');
const CASE_MS = 60_000;

let reading: Reading;

describe.skipIf(CHROME === null)('a mock thread whose comment holds markdown', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: CASE_MS - 5_000 });
    expect(r.status, r.stderr).toBe(0);
    reading = JSON.parse(r.stdout) as Reading;
  }, CASE_MS);

  it(
    'draws the link, the bold words and the list',
    () => {
      const b = reading['t-md'];
      expect(b.opened, 'the popover opened').toBe(true);
      expect(b.links).toEqual([
        {
          href: 'https://example.com/riverbend?a=1&b=2',
          text: 'the Riverbend pier',
          rel: 'noopener noreferrer',
          target: '_blank',
        },
      ]);
      expect(b.strong).toEqual(['before']);
      expect(b.li).toEqual(['north gate', 'south gate']);
      expect(b.text).not.toContain('](');
    },
    CASE_MS,
  );

  it(
    'draws a javascript: link and raw HTML as inert words',
    () => {
      const b = reading['t-xss'];
      expect(b.opened, 'the popover opened').toBe(true);
      expect(b.links).toEqual([]);
      expect(b.injected).toBe(0);
      expect(b.pwned).toBe(false);
      expect(b.text).toContain('[x](javascript:alert(1))');
      expect(b.text).toContain('<img src=x onerror=');
    },
    CASE_MS,
  );
});
