import { spawnSync } from 'node:child_process';
/**
 * The one line on the strip that reports a capture being LOST mid-meeting —
 * measured at both the widths Bryan reads on.
 *
 * WHAT IT IS FOR. The recording going silent was only half the incident; the
 * other half was that nothing told him until afterwards. So this line has a
 * job no other note on the strip has: it has to be readable at arm's length
 * while people are talking, it has to name what stopped AND what is still
 * being recorded, and where only a person's press can fix it — the share
 * picker is a modal no page may open by itself — it has to carry a control
 * they can actually hit.
 *
 * WHY A REAL BROWSER. `css-harness.ts` resolves the cascade but not layout,
 * and every claim here is a used value: whether a 16px sentence and a button
 * fit inside a 430px strip, how tall the target ends up, and whether the row
 * grew for the sentence or clipped it. The DOM is built by the real
 * `createMeetingFeed` over the real stylesheets and the sentence comes from
 * the real `streamAlarm`, so a rename or a reworded declaration cannot pass
 * this file — only a rendering that still works can.
 *
 * The strip's own container is written out here rather than mounted, because
 * `mountMeetingStrip` would start a meeting to get one. Its shape — the
 * classes, the blinker, the clock, the feed — is what that module builds and
 * what `meeting-strip-css.test.ts` already holds it to.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUN_ID_ENV, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';

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
 * The renderer and the wording, bundled for the page.
 *
 * `bun build` rather than a stub: what draws the line in the browser has to be
 * the module that draws it in the app, or the measurement is of a copy.
 */
function bundle(dir: string): string {
  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    [
      `import { createMeetingFeed } from ${JSON.stringify(join(SRC, 'meeting-feed.ts'))};`,
      `import { streamAlarm } from ${JSON.stringify(join(SRC, 'meeting-stream-health.ts'))};`,
      'globalThis.__cw = { createMeetingFeed, streamAlarm };',
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

/**
 * The sheets the review shell links, in its own order.
 *
 * audit: not-source — the text is INSTALLED into a real browser and never
 * asserted on. Every expectation below is a measured pixel or a computed
 * value, so a renamed selector or a reworded declaration can neither pass nor
 * fail a case here.
 */
const sheet = (name: string): string => readFileSync(join(SRC, name), 'utf8');

/** The strip as the shell mounts it, with the feed line empty. */
function page(js: string): string {
  const sheets = ['board.css', 'styles.css', 'doc.css', 'tokens.css']
    .map((n) => `<style>${sheet(n)}</style>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
${sheets}
<style>html,body{margin:0}</style>
</head><body>
<div id="meeting-strip" class="meeting-strip is-live" data-state="recording">
  <span class="meeting-blinker" aria-hidden="true"></span>
  <span class="meeting-elapsed">02:14</span>
  <div class="meeting-feed"><div class="meeting-feed-inner meeting-caption-line" aria-live="polite"></div></div>
</div>
<script>${js}</script>
</body></html>`;
}

const owned: string[] = [];
const dirs: string[] = [];

/** One headless run at one viewport: build the page, evaluate, parse. */
function run(preset: 'ipad' | 'phone'): AlarmReading {
  const dir = mkdtempSync(join(tmpdir(), 'cw-stream-alarm-'));
  dirs.push(dir);
  const html = join(dir, 'strip.html');
  writeFileSync(html, page(bundle(dir)));
  const probeFile = join(dir, 'probe.js');
  writeFileSync(probeFile, ALARM_PROBE);
  const runId = `streamalarm${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [
      SHOT,
      '--url',
      `file://${html}`,
      '--preset',
      preset,
      '--settle',
      '250',
      '--eval-file',
      probeFile,
    ],
    { encoding: 'utf8', timeout: 120_000, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse((JSON.parse(r.stdout) as { result: string }).result) as AlarmReading;
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
 * A launch plus a load is 4-6s on this machine and vitest's default case
 * budget is 5s, so the default would lose to the browser rather than to an
 * assertion.
 */
const BROWSER_CASE_MS = 60_000;

interface AlarmReading {
  /** The sentence the real `streamAlarm` produced for this state. */
  text: string;
  fontSize: number;
  /** The alarm's own box, and the strip it has to stay inside. */
  alarmRight: number;
  stripInnerRight: number;
  stripHeight: number;
  bodyScrollWidth: number;
  bodyClientWidth: number;
  /** The button: that it is one, what it says, and how big a target it is. */
  buttonTag: string;
  buttonLabel: string;
  buttonHeight: number;
  buttonRight: number;
  /** Pressing it asked for that stream back. */
  pressedStream: string | null;
  /** With the mic lost instead — the case that offers no button. */
  micText: string;
  micHasButton: boolean;
}

const ALARM_PROBE = `(() => {
  const line = document.querySelector('.meeting-caption-line');
  const strip = document.getElementById('meeting-strip');
  let lost = [{ stream: 'system', reason: 'ended', recovering: false }];
  let running = ['mic'];
  const pressed = [];
  const feed = window.__cw.createMeetingFeed({
    line,
    state: () => ({ kind: 'recording' }),
    turns: () => [],
    mode: () => 'conversation',
    startNote: () => '',
    standingNote: () => '',
    streamAlarm: () => window.__cw.streamAlarm({ lost, running }),
    restoredLine: () => '',
    reopenStream: (s) => pressed.push(s),
    names: () => ({}),
    liveBot: () => null,
    botFarewell: () => null,
    nameSpeaker: () => {},
    dismissBotNote: () => {},
  });
  feed.renderFeed();

  const alarm = line.querySelector('.meeting-stream-alarm');
  const press = line.querySelector('.meeting-note-action');
  const box = (el) => el.getBoundingClientRect();
  const stripStyle = getComputedStyle(strip);
  const out = {
    text: alarm ? alarm.textContent : '',
    fontSize: alarm ? Math.round(Number.parseFloat(getComputedStyle(alarm).fontSize)) : 0,
    alarmRight: alarm ? Math.round(box(alarm).right) : 0,
    stripInnerRight: Math.round(box(strip).right - Number.parseFloat(stripStyle.paddingRight)),
    stripHeight: Math.round(box(strip).height),
    bodyScrollWidth: document.documentElement.scrollWidth,
    bodyClientWidth: document.documentElement.clientWidth,
    buttonTag: press ? press.tagName : '',
    buttonLabel: press ? press.textContent : '',
    buttonHeight: press ? Math.round(box(press).height) : 0,
    buttonRight: press ? Math.round(box(press).right) : 0,
    pressedStream: null,
    micText: '',
    micHasButton: false,
  };
  if (press) { press.click(); out.pressedStream = pressed[0] ?? null; }

  // The other half of the asymmetry: a microphone reopens with no gesture, so
  // while it is being retried the strip says so and offers nothing to press.
  lost = [{ stream: 'mic', reason: 'ended', recovering: true }];
  running = ['system'];
  feed.renderFeed();
  const micAlarm = line.querySelector('.meeting-stream-alarm');
  out.micText = micAlarm ? micAlarm.textContent : '';
  out.micHasButton = line.querySelector('.meeting-note-action') !== null;
  return JSON.stringify(out);
})()`;

/** What both widths have to be true of, whatever the layout does between them. */
function assertAlarm(r: AlarmReading, width: number): void {
  // It names what stopped AND what is still recording — the whole reason a
  // person does not stop a meeting that is still catching their words.
  expect(r.text).toContain("This Mac's audio stopped");
  expect(r.text).toContain('Still recording the microphone');

  // Body size, not the strip's 13px chrome: this line is read at arm's length
  // off an iPad while people are talking.
  expect(r.fontSize).toBe(16);

  // The way back is a real control, labelled with what it will do.
  expect(r.buttonTag).toBe('BUTTON');
  expect(r.buttonLabel).toBe("Share this Mac's audio again");
  // A target somebody has to hit mid-meeting, not a 16px line of text.
  expect(r.buttonHeight).toBeGreaterThanOrEqual(30);
  // And it asks for the stream that died.
  expect(r.pressedStream).toBe('system');

  // Nothing pushed out of the strip, and nothing pushed the page sideways.
  expect(r.alarmRight).toBeLessThanOrEqual(r.stripInnerRight);
  expect(r.buttonRight).toBeLessThanOrEqual(r.stripInnerRight);
  expect(r.bodyScrollWidth).toBe(r.bodyClientWidth);
  expect(r.bodyClientWidth).toBe(width);

  // The strip grew for the sentence rather than clipping it at its 36px rest
  // height — the row is `auto` in the shell, so this comes back when it goes.
  expect(r.stripHeight).toBeGreaterThan(36);

  // The microphone's half: retried without asking, so it says so and offers
  // no button, because there is nothing for a person to do.
  expect(r.micText).toContain('The microphone stopped');
  expect(r.micText).toContain('Trying to get it back.');
  expect(r.micHasButton).toBe(false);
}

describe.skipIf(CHROME === null)('the strip while a capture is down', () => {
  it(
    'reads and can be pressed at 1180x820',
    () => {
      assertAlarm(run('ipad'), 1180);
    },
    BROWSER_CASE_MS,
  );

  it(
    'reads and can be pressed at 430px',
    () => {
      assertAlarm(run('phone'), 430);
    },
    BROWSER_CASE_MS,
  );
});
