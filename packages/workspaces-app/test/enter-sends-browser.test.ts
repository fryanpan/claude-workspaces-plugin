/**
 * Enter sends in every comment box, in a real browser: the task panel's
 * Comments box, the board's thread card (the doc's reply box), and the
 * widget's box on a mock. Shift+Enter is a new line, an IME's Enter never
 * sends, an emptied box sends nothing, and Cmd+Enter still sends.
 *
 * Before this the task box sent only on Cmd+Enter, and the card and the
 * widget sent on Safari's IME Enter (keyCode 229 with `isComposing` false).
 * The readings carry the key each step was taken under, so the IME cases
 * cannot pass on a key that was not the IME's.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { BoxRun } from './enter-sends-browser-page.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'enter-sends-browser-driver.ts');
/** A launch, a build and three mounts: well past vitest's 5s default. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

let runs: BoxRun[] = [];

/** Awaited rather than `spawnSync`: a worker blocked on a browser launch stops
 *  answering vitest's RPC (`secret-save-bar.test.ts`). */
function drive(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [DRIVER], { timeout: SPAWN_MS });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(CHROME === null)('Enter in a comment box', () => {
  beforeAll(async () => {
    const r = await drive();
    expect(r.code, r.stderr).toBe(0);
    runs = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '[]') as BoxRun[];
  }, SUITE_MS);

  for (const kind of ['task', 'card', 'widget'] as const) {
    const run = (): BoxRun => {
      const hit = runs.find((r) => r.kind === kind);
      if (!hit) throw new Error(`no reading for ${kind}`);
      return hit;
    };

    it(`${kind}: Shift+Enter is a new line and sends nothing`, () => {
      const r = run().afterShiftEnter;
      expect(r.lastEnter?.shiftKey).toBe(true);
      expect(r.sent).toEqual([]);
      expect(r.value).toMatch(/one\s*\ntwo/);
    });

    it(`${kind}: an IME's Enter never sends, in Safari's shape or Chrome's`, () => {
      const safari = run().afterSafariIme;
      expect(safari.lastEnter).toMatchObject({ isComposing: false, keyCode: 229 });
      expect(safari.sent).toEqual([]);
      const chrome = run().afterChromeIme;
      expect(chrome.lastEnter?.isComposing).toBe(true);
      expect(chrome.sent).toEqual([]);
    });

    it(`${kind}: Enter sends what was typed and empties the box`, () => {
      const r = run().afterEnter;
      expect(r.sent).toHaveLength(1);
      expect(r.sent[0]).toMatch(/one\s*\ntwo/);
      expect(r.value).toBe('');
    });

    it(`${kind}: Enter in the emptied box sends nothing`, () => {
      expect(run().afterEmptyEnter.sent).toHaveLength(1);
    });

    it(`${kind}: Cmd+Enter still sends`, () => {
      expect(run().afterCmdEnter.sent.at(-1)).toBe('three');
    });
  }
});
