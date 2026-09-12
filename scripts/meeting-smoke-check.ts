#!/usr/bin/env bun
/**
 * `bun run check:meeting-smoke` — hold a whole meeting, and fail if it does
 * not leave usable notes behind.
 *
 * WHY THIS EXISTS. A five-minute recording on 2026-09-11 produced one line of
 * notes, a live transcript that kept old phrases for the rest of the meeting,
 * and no summary in the log. Every gate was green, and every one of them had
 * tested a PIECE: the compose pipeline against a scripted harness, the live
 * zone against a fake DOM, the built client against a page with no meeting on
 * it. Nothing had ever run a meeting from a real browser through a real
 * server and looked at what the reader ends up with.
 *
 * So this is the whole path, once, cheaply:
 *
 *   real headless Chrome → the built client → the real audio socket →
 *   the real transcription seam → the real notes pipeline → the real doc
 *
 * with two things faked, and only two: the microphone (Chrome's own fake
 * capture device) and the words it produces (`createMockTranscriptionEngine`,
 * which advances one word per audio frame and so needs no clock of its own).
 * The note-taker is `createStubNotesComposer`, the deterministic composer the
 * server already ships for tests.
 *
 * THERE IS NO MODEL CALL HERE, and that is a requirement rather than a
 * convenience (Bryan, 2026-09-11): a gate that costs money per run is a gate
 * somebody eventually takes out of `verify`. This one costs a browser launch.
 *
 * WHAT IT ASSERTS — the three things the meeting got wrong:
 *
 *   1. NOTES ACCUMULATE. More than one tick writes, and the earlier note is
 *      still there when the later one lands. The reported symptom was a
 *      single line replaced by each new topic.
 *   2. WORDS THE NOTE-TAKER IS FINISHED WITH LEAVE THE LIVE TRANSCRIPT. One
 *      tick here composes nothing, which is an ordinary thing for a tick of
 *      filler to do. Its words must go. Before the fix in this branch they
 *      stayed on screen for the rest of the meeting, which is the half of the
 *      report this check reproduces: it FAILS on the base commit here.
 *   3. THE MEETING REPORTS ITSELF. The `[meeting-notes] … ticks over … turns`
 *      line prints when the recording stops. Its absence was the only trace
 *      the production meeting left, and an absence is not something the
 *      pipeline tests can see.
 *   4. THE FIRST THING SAID REACHES THE NOTES, and no bullet in the section
 *      is ever a blank line. The 2026-09-11 recording opened its section with
 *      an empty bullet, lost the first turn outright and kept the blank line
 *      wearing the fresh-note tint for the rest of the meeting. So the first
 *      composer call here answers with exactly that — a heading and a bullet
 *      with nothing in it — and the check asks whether the words survived it.
 *      It FAILS on the base commit of this branch.
 *
 * WHAT IT DOES NOT COVER. One doc, one speaker, one width, four turns, no
 * model. It is a smoke test, not a notes-quality eval — `bun run notes:eval`
 * is that, and it bills. Widening this is fine; letting it get slow enough
 * that somebody takes it out of `verify` is not.
 *
 *   bun run check:meeting-smoke [--keep] [--port N] [--shot <png>]
 *
 * `--shot` writes a screenshot of the doc at 1180x820 once every assertion has
 * passed — the reader's own view of the meeting this check just held. Nothing
 * in `verify` passes it; it is for a person reviewing a change to the notes.
 *
 * All fixtures are invented place names. The repo is public.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareClientRelease } from '../packages/server/src/client-release.ts';
import {
  type NotesComposer,
  createStubNotesComposer,
} from '../packages/server/src/meeting-notes.ts';
import { MEETING_NOTES_HEADING } from '../packages/server/src/notes-doc-access.ts';
import { type ServerHandle, createServer } from '../packages/server/src/server.ts';
import {
  type MockScriptTurn,
  createMockTranscriptionEngine,
} from '../packages/server/src/transcribe.ts';
import {
  type Browser,
  Cdp,
  killAndRemove,
  launchChrome,
  pageSocketUrl,
  sleep,
  withTimeout,
} from './headless-chrome.ts';
import {
  chromeLaunchArgs,
  extraChromeArgs,
  resolveChromeBin,
  resolveRunId,
} from './ui-shot-lib.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (msg: string): void => {
  process.stderr.write(`meeting-smoke: ${msg}\n`);
};

/** iPad landscape, the device this repo verifies at. */
const VIEWPORT = { width: 1180, height: 820 } as const;
const EDITOR_SELECTOR = '#editor > .ProseMirror';
const IDENTITY_NAME_KEY = 'feedback-user-name';

/**
 * What gets said. Four turns of invented survey talk, one of them filler —
 * the mock engine reveals one word per audio frame, and the client sends
 * twenty frames a second, so this is about four seconds of speech.
 */
const SCRIPT: readonly MockScriptTurn[] = [
  {
    words: [
      'the',
      'harborlight',
      'survey',
      'starts',
      'on',
      'the',
      'first',
      'monday',
      'of',
      'March',
    ],
    settled: 'The Harborlight survey starts on the first Monday of March.',
  },
  {
    words: ['right', 'yes', 'mm', 'okay', 'sure', 'right', 'yes', 'okay', 'mm', 'sure'],
    settled: 'Right, yes, mm, okay, sure, right, yes, okay, mm, sure.',
  },
  {
    words: ['riverbend', 'needs', 'two', 'more', 'boats', 'before', 'the', 'thaw', 'either', 'way'],
    settled: 'Riverbend needs two more boats before the thaw, either way.',
  },
  {
    words: ['saltmarsh', 'covers', 'the', 'second', 'week', 'and', 'the', 'week', 'after', 'that'],
    settled: 'Saltmarsh covers the second week, and the week after that.',
  },
  {
    words: ['the', 'slipway', 'quote', 'came', 'back', 'under', 'budget', 'by', 'nine', 'percent'],
    settled: 'The slipway quote came back under budget by nine percent.',
  },
  {
    words: ['we', 'lose', 'the', 'tide', 'window', 'if', 'the', 'crane', 'slips', 'again'],
    settled: 'We lose the tide window if the crane slips again.',
  },
  {
    words: [
      'harborlight',
      'wants',
      'the',
      'draft',
      'timetable',
      'before',
      'the',
      'board',
      'meets',
      'again',
    ],
    settled: 'Harborlight wants the draft timetable before the board meets again.',
  },
];

/** The first thing said — the sentence the 2026-09-11 meeting lost. */
const FIRST_TURN = SCRIPT[0]?.settled ?? '';

/**
 * Ticks on the CADENCE clock rather than on pauses, because the fake
 * microphone never stops talking: a capture device producing a continuous
 * signal gives the pause ticker no pause to fire on. Short enough that four
 * seconds of speech crosses several ticks.
 */
const CADENCE_MS = 700;
const QUIET_MS = 400;

/**
 * Which composer call answers the way the production model did on the tick
 * that opened the section: the heading, and a bullet with no words in it.
 *
 * The first call, because that is the tick the report is about — the one
 * holding the first thing anybody said.
 */
const BLANK_BULLET_CALL = 1;

/** Which composer call answers with nothing — see assertion 2. Not the call
 *  above, and not the one after it: the blank-bullet tick's words carry into
 *  the next call, which has to be one that writes them. */
const EMPTY_TICK_CALL = 3;

/** How long a browser-side condition may take before it is a failure. */
const SETTLE_MS = 8_000;
/** How long the meeting may run before it has to have produced its ticks. */
const MEETING_MS = 30_000;

interface Options {
  keep: boolean;
  port: number;
  /** Where to write a screenshot of the finished doc, if anywhere. */
  shot?: string;
}

export function parseArgs(argv: readonly string[]): Options {
  const o: Options = { keep: false, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') o.keep = true;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--shot') o.shot = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function build(pkg: string): void {
  const r = spawnSync('bun', ['run', join(REPO_ROOT, 'packages', pkg, 'scripts', 'build.ts')], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (r.status !== 0) throw new Error(`${pkg} build failed with status ${r.status}`);
}

/** One composer call, as it happened. */
interface Composed {
  /** The settled words this tick was handed. */
  said: string[];
  /**
   * What this call answered with.
   *
   * `blank` is the scripted failure — an answer that LOOKS like a write and
   * puts no words in the doc — so it is neither of the other two: a reader
   * counting what wrote must not count it, and a reader counting the tick
   * that composed nothing must not either.
   */
  kind: 'wrote' | 'empty' | 'blank';
}

/**
 * The note-taker: the server's own deterministic stub, answering with nothing
 * on one call.
 *
 * A tick that composes nothing is ORDINARY — a tick of "right, yes, okay" has
 * nothing to write up — and the server marks its turns composed and never
 * looks at them again. That is what makes those words the ones the live
 * transcript used to keep forever, so the check needs one on purpose rather
 * than hoping the script produces one.
 */
function scriptedComposer(seen: Composed[]): NotesComposer {
  const stub = createStubNotesComposer();
  return {
    name: 'meeting-smoke',
    async compose(input) {
      const said = input.tick.turns.map((t) => t.text);
      if (said.length === 0) return [];
      const call = seen.length + 1;
      if (call === BLANK_BULLET_CALL) {
        seen.push({ said, kind: 'blank' });
        return [{ op: 'insert_at_end', markdown: `## ${MEETING_NOTES_HEADING}\n\n- ` }];
      }
      const edits = call === EMPTY_TICK_CALL ? [] : await stub.compose(input);
      seen.push({ said, kind: edits.length > 0 ? 'wrote' : 'empty' });
      return edits;
    },
  };
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

/** A board and a doc to hold the meeting on, seeded over the real routes. */
async function seedDoc(base: string, dataDir: string): Promise<{ ws: string; docId: string }> {
  const board = (await postJson(`${base}/workspaces`, {
    name: 'meeting smoke check',
    author: { id: 'agent:meeting-smoke', name: 'meeting-smoke', kind: 'agent' },
  })) as { workspace?: { id?: string } };
  const ws = board.workspace?.id;
  if (!ws) throw new Error(`no workspace id: ${JSON.stringify(board)}`);
  const docId = 'meeting-smoke';
  const path = join(dataDir, `${docId}.md`);
  writeFileSync(path, '# Survey planning\n\nWhat we agreed before the recording started.\n');
  await postJson(`${base}/workspaces/${ws}/docs`, {
    docId,
    type: 'markdown',
    title: 'Survey planning',
    sourceUrl: path,
  });
  return { ws, docId };
}

/** Poll until `pred` reads true in the page, or fail saying what was wanted. */
async function until(cdp: Cdp, expr: string, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await cdp.evaluate(expr)) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(100);
  }
}

/** Poll until a condition in THIS process reads true. */
async function untilHere(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(50);
  }
}

const js = (v: unknown): string => JSON.stringify(v);

async function run(o: Options): Promise<number> {
  const chrome = resolveChromeBin(undefined);
  build('widget');
  build('workspaces-app');

  const dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-smoke-data-'));
  const releaseRoot = mkdtempSync(join(tmpdir(), 'cw-meeting-smoke-release-'));
  const composed: Composed[] = [];
  /** Every line the server printed, so the summary's absence is visible. */
  const printed: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]): void => {
    printed.push(a.join(' '));
    realLog(...a);
  };
  console.error = (...a: unknown[]): void => {
    printed.push(a.join(' '));
    realError(...a);
  };

  let server: ServerHandle | undefined;
  let browser: Browser | undefined;
  let cdp: Cdp | undefined;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    console.log = realLog;
    console.error = realError;
    try {
      cdp?.close();
    } catch {}
    if (browser) killAndRemove(browser.proc, browser.profile);
    void server?.stop();
    if (o.keep) {
      log(`kept ${dataDir} and ${releaseRoot}`);
      return;
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(releaseRoot, { recursive: true, force: true });
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }

  try {
    // The same publish prod performs. Serving `dist` directly would test
    // bytes nobody receives.
    const prepared = prepareClientRelease({
      root: releaseRoot,
      sources: {
        widget: join(REPO_ROOT, 'packages', 'widget', 'dist'),
        markdownApp: join(REPO_ROOT, 'packages', 'workspaces-app', 'dist'),
      },
    });
    if (prepared.stale || !prepared.markdownApp) {
      throw new Error(`client release was not published: ${prepared.error ?? 'unknown'}`);
    }

    // In-process rather than a spawned `bin.ts`, because the mock engine and
    // the stub composer are constructor options and production has no flag
    // that injects them — nor should it. Everything else is the real server.
    server = createServer({
      port: o.port,
      dataDir,
      requireSignInToWrite: false,
      markdownAppDistDir: prepared.markdownApp,
      ...(prepared.widget ? { widgetDistDir: prepared.widget } : {}),
      transcription: createMockTranscriptionEngine(SCRIPT),
      meetingNotes: {
        composer: scriptedComposer(composed),
        cadenceMs: CADENCE_MS,
        quietMs: QUIET_MS,
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const { ws, docId } = await seedDoc(base, dataDir);
    // `?huddle=1&mode=solo` is the address the Board writes when somebody
    // presses "Have a meeting", and the editor starts the capture on load —
    // so the meeting begins the way a person's does, with no synthetic click.
    const pageUrl = `${base}/workspaces/${ws}/docs/${docId}?huddle=1&mode=solo`;
    log(`opening ${pageUrl}`);

    browser = await launchChrome(
      chrome,
      (profile) =>
        chromeLaunchArgs(VIEWPORT, profile, [
          ...extraChromeArgs(),
          // The microphone. Chrome's own generated capture device, granted
          // without a prompt — the one thing a headless meeting cannot have
          // for real.
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
        ]),
      30_000,
      resolveRunId(),
      (b) => {
        browser = b;
      },
    );
    cdp = await Cdp.connect(await pageSocketUrl(browser.port, 30_000));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // A throwaway profile is a first arrival, and a first arrival gets the
    // "Who's reviewing?" modal, under which no editor builds.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem(${js(IDENTITY_NAME_KEY)}, 'meeting-smoke'); } catch {}`,
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...VIEWPORT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const loaded = cdp.once('Page.loadEventFired');
    const nav = await cdp.send('Page.navigate', { url: pageUrl });
    if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
    await withTimeout(loaded, 30_000, 'page load');
    await until(cdp, `!!document.querySelector(${js(EDITOR_SELECTOR)})`, 20_000, 'the editor');
    await until(cdp, `!!document.querySelector('.meeting-record-dot')`, 20_000, 'the strip');

    // 4a. THE FIRST THING SAID SURVIVES THE TICK THAT OPENED THE SECTION
    //     WITH A BLANK. That tick put no words in the doc, so the pipeline
    //     owes them still — and the very next composer call has to be handed
    //     them. Asserted on the CALL rather than on the doc, because what is
    //     under test is that the words were never counted as written up.
    await untilHere(
      () => composed.length >= 2,
      MEETING_MS,
      `a second composer call (saw ${composed.length})`,
    );
    if (composed[0]?.kind !== 'blank') {
      throw new Error(`the first call was ${composed[0]?.kind ?? 'never made'}, not the blank one`);
    }
    const secondSaw = composed[1]?.said ?? [];
    if (!secondSaw.some((s) => s.includes(FIRST_TURN))) {
      throw new Error(
        `the tick after the blank bullet was not handed the first turn again — it heard ${JSON.stringify(secondSaw)}`,
      );
    }

    // The meeting runs until the script has been spoken and the ticks it
    // needs have composed: two that wrote and the one that answered with
    // nothing.
    await untilHere(
      () =>
        composed.filter((c) => c.kind === 'wrote').length >= 2 &&
        composed.some((c) => c.kind === 'empty'),
      MEETING_MS,
      `ticks (saw ${composed.length}: ${composed.map((c) => c.kind).join(', ')})`,
    );
    const wrote = composed.filter((c) => c.kind === 'wrote');
    const empty = composed.find((c) => c.kind === 'empty');
    if (!empty)
      throw new Error('no tick composed nothing, so the live-transcript half is untested');

    // 4b. AND IT IS IN THE NOTES, with no blank line left behind it. The two
    //     halves of the report: the sentence that went missing, and the
    //     bullet that stood in its place.
    await until(
      cdp,
      `(() => { const t = document.querySelector(${js(EDITOR_SELECTOR)})?.textContent ?? '';
         return t.includes(${js(FIRST_TURN)}); })()`,
      SETTLE_MS,
      `the first thing said (${JSON.stringify(FIRST_TURN)}) in the notes`,
    );
    const blanks = (await cdp.evaluate(
      `[...document.querySelectorAll(${js(`${EDITOR_SELECTOR} li`)})]
         .filter((li) => (li.textContent ?? '').trim().length === 0).length`,
    )) as number;
    if (blanks > 0) {
      throw new Error(`${blanks} bullet(s) in the notes are blank lines carrying the live bar`);
    }

    // 1. NOTES ACCUMULATE. Every written tick's words are still in the prose,
    //    as separate list items — not one line rewritten by the latest topic.
    const wantedNotes = wrote.flatMap((c) => c.said);
    await until(
      cdp,
      `(() => { const t = document.querySelector(${js(EDITOR_SELECTOR)})?.textContent ?? '';
         return ${js(wantedNotes)}.every((s) => t.includes(s)); })()`,
      SETTLE_MS,
      `every written tick's words in the notes (${wantedNotes.length} turns over ${wrote.length} ticks)`,
    );
    const items = (await cdp.evaluate(
      `document.querySelectorAll(${js(`${EDITOR_SELECTOR} li`)}).length`,
    )) as number;
    if (items < 2) {
      throw new Error(
        `the notes are ${items} list item(s); a meeting of ${wrote.length} written ticks must leave more than one`,
      );
    }

    // 2. WORDS THE NOTE-TAKER IS FINISHED WITH LEAVE. The empty tick's turns
    //    are composed as far as the server is concerned and will never be
    //    looked at again, so the live transcript must give them up.
    await until(
      cdp,
      `(() => { const t = document.querySelector('.live-zone .lz-lines')?.textContent ?? '';
         return ${js(empty.said)}.every((s) => !t.includes(s)); })()`,
      SETTLE_MS,
      "the empty tick's words to leave the live transcript",
    );

    // 3. THE MEETING REPORTS ITSELF, through the real stop the strip's menu
    //    offers rather than by dropping the socket.
    await cdp.evaluate(`document.querySelector('.meeting-record')?.click(), 1`);
    await until(
      cdp,
      `!!document.querySelector('.meeting-stop-cta')`,
      SETTLE_MS,
      'the stop control',
    );
    await cdp.evaluate(`document.querySelector('.meeting-stop-cta')?.click(), 1`);
    const summary = /\[meeting-notes\].*meeting.*: \d+ ticks? over \d+ settled turns?/;
    await untilHere(
      () => printed.some((l) => summary.test(l)),
      SETTLE_MS,
      'the meeting summary line',
    );

    if (o.shot !== undefined) {
      const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
      mkdirSync(dirname(o.shot), { recursive: true });
      writeFileSync(o.shot, Buffer.from(png.data, 'base64'));
      log(`wrote ${o.shot}`);
    }

    const line = printed.find((l) => summary.test(l)) ?? '';
    log(
      `✅ a whole meeting left usable notes: ${wrote.length} ticks wrote, one composed nothing and its words left, ${items} note lines, no blank bullet, and the first thing said is in them.`,
    );
    log(`   ${line.trim()}`);
    return 0;
  } catch (err) {
    log(`❌ ${err instanceof Error ? err.message : String(err)}`);
    log(`   composer calls: ${composed.map((c, i) => `${i + 1}:${c.kind}`).join(' ') || 'none'}`);
    return 1;
  } finally {
    cleanup();
  }
}

if (import.meta.main) {
  process.exit(await run(parseArgs(process.argv.slice(2))));
}
