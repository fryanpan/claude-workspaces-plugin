import { spawnSync } from 'node:child_process';
/**
 * The capture path, driven in a real browser against a real MediaStreamTrack.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `meeting-track-watch.test.ts`. That one
 * drives the watch against fakes, and a fake track is a thing this repo wrote:
 * it ends when we say it ends and fires what we say it fires. The bug being
 * fixed here is a browser fact — a `MediaStreamTrack` can stop delivering
 * while everything downstream of it keeps running — and the two halves that
 * make it dangerous are both platform behaviour no fake can vouch for:
 *
 *   1. `track.stop()` ends a track SILENTLY. The spec says no `ended` event
 *      fires, and the whole reason `watchTracks` reads `readyState` on the
 *      audio block clock is that half the ends it must catch arrive with no
 *      event at all. Here that is measured rather than cited: the probe
 *      installs its own `ended` listener and reports how many times it fired.
 *   2. A `MediaStreamAudioSourceNode` whose track has died keeps being pulled
 *      and keeps delivering SILENCE. That is the original incident in one
 *      sentence — frames still leaving the device, the socket still open, the
 *      engine hearing a quiet room — and it is what makes the failure an
 *      absence rather than an error. The probe deliberately does NOT tear the
 *      capture down after the loss, so the frames that keep arriving can be
 *      counted and their energy summed.
 *
 * THE SIGNAL IS AN OSCILLATOR, NOT CHROME'S FAKE MICROPHONE. Both give a real
 * `MediaStream` with real track semantics; only one gives a signal that is
 * always there. `--use-fake-device-for-media-stream` produces a beep pattern
 * that is mostly silence, measured here at zero energy across whole windows,
 * which would turn "the frames after the death are silence" into a coin flip.
 * So the streams that get killed come from a `MediaStreamAudioDestinationNode`
 * fed by a 440Hz oscillator — a real Blink media stream carrying an unbroken
 * tone — and the browser's own `getUserMedia` door is exercised separately by
 * the control capture, which is never interfered with.
 *
 * WHAT IT DOES NOT PROVE. AC4 asks for real meetings with a real screen share.
 * No test can start Chrome's share picker, and driving a person's browser is
 * forbidden. This is the automated substitute: three start/stop cycles, both
 * kinds of end, a recovery between each, and the silence measured on the far
 * side. The real-meeting confirmation is Bryan's step and is not done here.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CHROME_ARGS_ENV,
  RUN_ID_ENV,
  profilesOfRun,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';

/**
 * Is there a browser to launch — asked the way `ui-shot.ts` itself asks, and
 * for the reason `meeting-prose-measure-css.test.ts` spells out: the macOS
 * `/Applications` constant is not the question, because a `skipIf` on it makes
 * these cases decorative everywhere else.
 */
const CHROME = ((): string | null => {
  try {
    return resolveChromeBin(undefined);
  } catch {
    return null;
  }
})();
const SRC = join(import.meta.dirname, '../src');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');

/**
 * The flags this page needs that a screenshot does not.
 *
 * `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`
 * give the control capture a microphone and answer its permission prompt;
 * `--autoplay-policy=no-user-gesture-required` lets the oscillator's
 * `AudioContext` actually run, since nothing in a headless page ever clicks.
 */
const MEDIA_FLAGS =
  '--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required';

/**
 * The modules under test, bundled for the page.
 *
 * `bun build` rather than a hand-written stub, because the point is that the
 * SHIPPED module runs: a copy of `watchTracks` pasted into a probe would prove
 * something about the copy. The entry only re-exports onto `window`, so what
 * the browser executes is the real `startMeetingCapture`, and the real
 * `watchTracks` underneath it.
 */
function bundle(dir: string): string {
  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    [
      `import { startMeetingCapture } from ${JSON.stringify(join(SRC, 'meeting-audio.ts'))};`,
      'globalThis.__cw = { startMeetingCapture };',
      '',
    ].join('\n'),
  );
  const built = spawnSync('bun', ['build', entry, '--target=browser'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
  return built.stdout;
}

/** A page carrying the module and nothing else — no chrome is under test. */
function page(js: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body><script>${js}</script></body></html>`;
}

const owned: string[] = [];
const dirs: string[] = [];

/** One headless run: build the page, evaluate the probe, parse its JSON. */
function run(probe: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'cw-track-death-'));
  dirs.push(dir);
  const html = join(dir, 'meeting.html');
  writeFileSync(html, page(bundle(dir)));
  const probeFile = join(dir, 'probe.js');
  writeFileSync(probeFile, probe);
  const runId = `trackdeath${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [
      SHOT,
      '--url',
      `file://${html}`,
      '--preset',
      'ipad',
      '--settle',
      '250',
      '--timeout',
      '40000',
      '--eval-file',
      probeFile,
    ],
    {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, [RUN_ID_ENV]: runId, [CHROME_ARGS_ENV]: MEDIA_FLAGS },
    },
  );
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse((JSON.parse(r.stdout) as { result: string }).result);
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const runId of owned) {
    for (const name of profilesOfRun(readdirSync(tmpdir()), runId)) {
      try {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      } catch {}
    }
  }
});

/**
 * A launch plus a load plus three kill-and-recover cycles. Vitest's default
 * case budget is 5s and a bare launch is already 4-6s on this machine, so the
 * default would lose to the browser rather than to an assertion.
 */
const BROWSER_CASE_MS = 120_000;

/* ===== the capture, killed three times ===== */

/** One kill-and-recover cycle, as the page measured it. */
interface Cycle {
  cycle: number;
  /** Frames were arriving before the kill — the control for everything after. */
  flowing: boolean;
  readyBefore: string;
  /** Summed |sample| over the last frames before the kill. The utterance. */
  energyBefore: number;
  reported: boolean;
  reason: string | null;
  readyAfter: string;
  /** How many `ended` events the browser fired. Zero is the interesting one. */
  endedEventsFired: number;
  /** Frames of pure silence that reached the wire before anyone was told. */
  silentFramesBeforeReport: number;
  /** Frames that kept arriving with nothing torn down. The bug. */
  framesAfterDeath: number;
  /** A window opened well after the death, past anything still in the graph. */
  framesLate: number;
  energyLate: number;
  reopened?: boolean;
  resumed?: boolean;
  energyAfterReopen?: number;
  lossesAfterReopen?: number;
}

interface CaptureReading {
  startOk: boolean;
  cycles: Cycle[];
  /** Stopping the meeting is not a loss. */
  lossesFromStopping: number;
  soloOk: boolean;
  soloFlowing: boolean;
  soloLosses: number;
  soloLossesAfterStop: number;
}

const CAPTURE_PROBE = `(async () => {
  const SECURE = { isSecureContext: true, protocol: 'https:', hostname: 'x.test', port: '', pathname: '/', search: '' };
  const energy = (f) => { let s = 0; for (const v of f) s += Math.abs(v); return s; };
  const until = async (fn, ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
    return false;
  };

  // A real MediaStream carrying a signal that is always there — see the file
  // header for why Chrome's fake microphone is not it.
  const tone = new AudioContext();
  await tone.resume();
  function toneStream() {
    const osc = tone.createOscillator();
    const dest = tone.createMediaStreamDestination();
    osc.frequency.value = 440;
    osc.connect(dest);
    osc.start();
    return dest.stream;
  }

  const frames = [];
  let losses = [];
  let live = null;
  let endedEvents = 0;
  const grew = async (by, ms) => { const at = frames.length; return until(() => frames.length >= at + by, ms); };
  const since = (at) => frames.slice(at).reduce((a, b) => a + b, 0);

  const started = await window.__cw.startMeetingCapture({
    onFrame: (pcm) => frames.push(energy(pcm)),
    onLost: (reason) => losses.push({ reason, atFrame: frames.length }),
    deps: {
      readOrigin: () => SECURE,
      getMedia: async () => {
        live = toneStream();
        for (const t of live.getAudioTracks()) t.addEventListener('ended', () => { endedEvents += 1; });
        return live;
      },
    },
  });
  if (!started.ok) return JSON.stringify({ startOk: false, err: started.message, cycles: [] });
  const capture = started.capture;
  const out = { startOk: true, cycles: [] };

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const c = { cycle };
    const track = live.getAudioTracks()[0];
    c.flowing = await grew(6, 5000);
    let at = frames.length - 6;
    c.readyBefore = track.readyState;
    // The tone never stops, so every one of these kills lands inside a
    // continuous run of audio — the share started mid-sentence.
    c.energyBefore = since(at);
    const eventsBefore = endedEvents;

    losses = [];
    const atKill = frames.length;
    // Cycle 1 is what a browser does when the SOURCE goes away: the track ends
    // AND an event arrives. Cycles 2 and 3 are \`stop()\` alone — the spec's
    // silent end, with no event for anything to listen to.
    if (cycle === 1) { track.stop(); track.dispatchEvent(new Event('ended')); }
    else track.stop();

    c.reported = await until(() => losses.length > 0, 5000);
    c.reason = losses[0] ? losses[0].reason : null;
    c.readyAfter = track.readyState;
    c.endedEventsFired = endedEvents - eventsBefore;
    c.silentFramesBeforeReport = frames
      .slice(atKill, losses[0] ? losses[0].atFrame : frames.length)
      .filter((e) => e === 0).length;

    // THE BUG, MEASURED. Nothing is torn down: the graph is still pulling a
    // node whose track is dead.
    const atLoss = frames.length;
    await new Promise((r) => setTimeout(r, 500));
    c.framesAfterDeath = frames.length - atLoss;
    // And a window that starts past anything still in flight when the track
    // died, so what it holds is only what a dead capture produces.
    const atLate = frames.length;
    await new Promise((r) => setTimeout(r, 500));
    c.framesLate = frames.length - atLate;
    c.energyLate = since(atLate);

    if (cycle < 3) {
      const again = await capture.reopen();
      c.reopened = again.ok;
      at = frames.length;
      c.resumed = await grew(6, 5000);
      c.energyAfterReopen = since(at);
      c.lossesAfterReopen = losses.length - 1;
    }
    out.cycles.push(c);
  }

  // Stopping the meeting is not a loss: the watch comes off before the track.
  const before = losses.length;
  capture.stop();
  await new Promise((r) => setTimeout(r, 400));
  out.lossesFromStopping = losses.length - before;

  // The control: the browser's own microphone door, never interfered with.
  const quiet = [];
  const quietLosses = [];
  const solo = await window.__cw.startMeetingCapture({
    onFrame: (pcm) => quiet.push(pcm.length),
    onLost: () => quietLosses.push(1),
    deps: { readOrigin: () => SECURE },
  });
  out.soloOk = solo.ok;
  if (solo.ok) {
    out.soloFlowing = await until(() => quiet.length >= 6, 5000);
    await new Promise((r) => setTimeout(r, 600));
    out.soloLosses = quietLosses.length;
    solo.capture.stop();
    await new Promise((r) => setTimeout(r, 300));
    out.soloLossesAfterStop = quietLosses.length;
  }
  return JSON.stringify(out);
})()`;

/**
 * One run, read by three cases.
 *
 * The probe is a whole meeting — three kills, two recoveries and a control
 * capture — and a browser launch per assertion would pay for that four times
 * over to measure the same session. The cases below split what is being said
 * about it, not what is being driven.
 */
let reading: CaptureReading | null = null;
const capture = (): CaptureReading => (reading ??= run(CAPTURE_PROBE) as CaptureReading);

describe.skipIf(CHROME === null)('a capture whose track dies under a running meeting', () => {
  it(
    'is noticed on every one of three kills, both with an event and without one',
    () => {
      const r = capture();
      expect(r.startOk).toBe(true);
      expect(r.cycles).toHaveLength(3);

      for (const c of r.cycles) {
        // The control for the whole cycle: audio really was arriving, and the
        // kill really did land inside it.
        expect(c.flowing, `cycle ${c.cycle} never delivered`).toBe(true);
        expect(c.readyBefore).toBe('live');
        expect(c.energyBefore, `cycle ${c.cycle} was silent before the kill`).toBeGreaterThan(0);

        // The loss itself, named.
        expect(c.reported, `cycle ${c.cycle} went unnoticed`).toBe(true);
        expect(c.reason).toBe('ended');
        expect(c.readyAfter).toBe('ended');

        // How much silence reached the wire before the person was told. A
        // frame is 50ms, so zero is "within one block of the audio graph".
        expect(c.silentFramesBeforeReport).toBe(0);

        // And the bug this exists for, in two numbers: the capture kept
        // producing frames after its track was dead, and they were silence.
        expect(c.framesAfterDeath, `cycle ${c.cycle} stopped on its own`).toBeGreaterThan(0);
        expect(c.framesLate).toBeGreaterThan(0);
        expect(c.energyLate).toBe(0);
      }

      // Cycle 1 is the browser's own end: an event fired, and it carried the
      // report. Cycles 2 and 3 are `stop()`, where NO event fires at all —
      // so the only thing that can have noticed is the read on the block
      // clock, and a build without it cannot pass these two lines.
      expect(r.cycles[0]?.endedEventsFired).toBe(1);
      expect(r.cycles[1]?.endedEventsFired).toBe(0);
      expect(r.cycles[2]?.endedEventsFired).toBe(0);
    },
    BROWSER_CASE_MS,
  );

  it(
    'comes back on a reopen, and the new capture can report its own death',
    () => {
      const r = capture();
      for (const c of r.cycles.slice(0, 2)) {
        expect(c.reopened, `cycle ${c.cycle} did not reopen`).toBe(true);
        expect(c.resumed, `cycle ${c.cycle} delivered nothing after the reopen`).toBe(true);
        // Frames again, and carrying audio rather than more silence.
        expect(c.energyAfterReopen).toBeGreaterThan(0);
        // The fresh leg does not inherit the old one's report.
        expect(c.lossesAfterReopen).toBe(0);
      }
      // Which is what makes cycles 2 and 3 possible at all: each is a loss
      // reported by a capture that had already lost and recovered once.
      expect(r.cycles[1]?.reported).toBe(true);
      expect(r.cycles[2]?.reported).toBe(true);
    },
    BROWSER_CASE_MS,
  );

  it(
    'leaves an untouched microphone meeting exactly as it was',
    () => {
      const r = capture();
      // A meeting with no screen share and nothing killed: the browser's own
      // getUserMedia, frames arriving, and nothing reported at any point.
      expect(r.soloOk).toBe(true);
      expect(r.soloFlowing).toBe(true);
      expect(r.soloLosses).toBe(0);
      // And ending a meeting is not a capture dying — neither the meeting the
      // cycles ran on nor the control one says a word on the way out.
      expect(r.lossesFromStopping).toBe(0);
      expect(r.soloLossesAfterStop).toBe(0);
    },
    BROWSER_CASE_MS,
  );
});
