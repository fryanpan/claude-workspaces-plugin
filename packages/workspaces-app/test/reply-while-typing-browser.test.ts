/**
 * An agent's reply landing while the reader types a reply on the same doc
 * thread, in a real browser against a real server: one Enter sends one
 * comment holding the whole sentence, and the keys never leave the box.
 *
 * Reported 4 Nov: a reply posted cut off at "And then", and the rest came as
 * a second comment. Below 1101px the card sits inline in the doc, and a new
 * comment on its thread rebuilds it. That rebuild carried the draft's words
 * but not the caret, so focus fell to `body` and every later key went nowhere.
 *
 * audit: no-text — the driver reads a running page and the server's thread
 * list; nothing here reads a source file, a bundle or a stylesheet.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { ReplyTypingRun, ReplyTypingScenario } from './reply-while-typing-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'reply-while-typing-driver.ts');
/** Ten launches, two builds and a sentence typed a key at a time. */
const SUITE_MS = 240_000;
const SPAWN_MS = 235_000;

let run: ReplyTypingRun = { scenarios: [] };

/** Awaited rather than `spawnSync`: a worker blocked on a browser launch stops
 *  answering vitest's RPC. */
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

const scenarioOf = (width: number, delivery: string): ReplyTypingScenario => {
  const hit = run.scenarios.find((s) => s.width === width && s.delivery === delivery);
  if (!hit) throw new Error(`no reading for ${width} ${delivery}`);
  return hit;
};

describe.skipIf(CHROME === null)('typing a reply while an agent replies', () => {
  beforeAll(async () => {
    const r = await drive();
    expect(r.code, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as ReplyTypingRun;
  }, SUITE_MS);

  for (const width of [1180, 430]) {
    for (const delivery of ['same-thread', 'mid-word', 'other-thread', 'burst']) {
      it(`${width}, ${delivery}: one comment posts, whole`, () => {
        const s = scenarioOf(width, delivery);
        expect(s.focusLost).toEqual([]);
        expect(s.boxBeforeSend).toBe(s.composed);
        expect(s.sent).toEqual([s.composed]);
        expect(s.posted).toEqual([s.composed]);
        expect(s.final).toBe('composer');
      });
    }

    // An agent's ask makes the box an answer box, and an answer needs a
    // signed-in person, so this fixture's send is refused after it leaves.
    it(`${width}, an ask lands: one send, whole, from the same box`, () => {
      const s = scenarioOf(width, 'same-thread-ask');
      expect(s.focusLost).toEqual([]);
      expect(s.boxBeforeSend).toBe(s.composed);
      expect(s.sent).toEqual([s.composed]);
    });
  }
});
