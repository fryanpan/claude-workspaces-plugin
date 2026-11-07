#!/usr/bin/env bun
/**
 * Pushes one synthetic voice through the real `createSpokenPlayer` twice, on
 * an OfflineAudioContext in headless Chromium: once as a single chunk, once
 * cut into chunks. Prints the largest sample difference per case as JSON,
 * for `spoken-player-joins-browser.test.ts`.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, launchChrome, pageSocketUrl, stopBrowser } from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';

export interface JoinRun {
  rate: number;
  chunkMs: number;
  peakDifference: number;
  peak: number;
}

const CASES = [48_000, 44_100].flatMap((rate) =>
  [20, 50, 100].map((chunkMs) => ({ rate, chunkMs })),
);

/** Runs in the page. `createSpokenPlayer` is the bundled real one. */
const IN_PAGE = `window.render = async (rate, chunkMs) => {
  const VOICE = 24000, n = VOICE * 2;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / VOICE;
    pcm[i] = Math.round(32767 * (0.2 * Math.sin(2 * Math.PI * 220 * t)
      + 0.2 * Math.sin(2 * Math.PI * 660 * t) + 0.15 * Math.sin(2 * Math.PI * 5000 * t)));
  }
  const play = async (samplesPerChunk) => {
    const off = new OfflineAudioContext(1, rate * 3, rate);
    const ctx = {
      sampleRate: rate, currentTime: 0.012345, state: 'running', resume: async () => {},
      createBuffer: (...a) => off.createBuffer(...a),
      createBufferSource: () => off.createBufferSource(),
      destination: off.destination,
    };
    const player = createSpokenPlayer({ context: () => ctx, onFirstWord() {}, now: () => 0 });
    player.begin(VOICE);
    for (let at = 0; at < n; at += samplesPerChunk) {
      player.push(new Uint8Array(pcm.buffer.slice(at * 2, Math.min(n, at + samplesPerChunk) * 2)));
    }
    return (await off.startRendering()).getChannelData(0);
  };
  const whole = await play(n);
  const cut = await play(Math.round((chunkMs / 1000) * VOICE));
  let peakDifference = 0, peak = 0;
  // Stop short of the end, where the two differ by the last half sample.
  const end = Math.floor(rate * 1.9);
  for (let i = 0; i < end; i++) {
    peakDifference = Math.max(peakDifference, Math.abs(whole[i] - cut[i]));
    peak = Math.max(peak, Math.abs(whole[i]));
  }
  return { rate, chunkMs, peakDifference, peak };
};`;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spoken-joins-'));
  try {
    const source = join(import.meta.dirname, '..', 'src', 'board', 'spoken-reply-audio.ts');
    const entry = join(dir, 'entry.ts');
    writeFileSync(
      entry,
      `import { createSpokenPlayer } from ${JSON.stringify(source)};\nObject.assign(window, { createSpokenPlayer });\n`,
    );
    const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
    const script = await built.outputs[0]?.text();
    if (!built.success || !script) throw new Error('the player did not build');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 400, height: 300 }, profile, ['--mute-audio']),
      STARTUP_TIMEOUT_MS,
      `spoken-joins-${process.pid}`,
      (started) => void browsers.push(started),
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Runtime.enable');
    const evaluate = async (expression: string): Promise<unknown> => {
      const r = (await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result?.value;
    };
    await evaluate(`${script};0`);
    await evaluate(`${IN_PAGE};0`);
    const runs: unknown[] = [];
    for (const c of CASES) runs.push(await evaluate(`render(${c.rate}, ${c.chunkMs})`));
    process.stdout.write(`${JSON.stringify(runs)}\n`);
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
