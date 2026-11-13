/**
 * A well-sourced doc's margin notes stay beside their lines while the reader
 * scrolls — measured in a real browser.
 *
 * THE FAULT. A research note with a source on nearly every paragraph. Its
 * notes were placed by the viewport, as comment cards are: a note off screen
 * was placed alone at its anchor, so two notes a line apart came into view on
 * top of each other, and they stayed that way for as long as the reader kept
 * scrolling, because the column only re-stacks once scrolling stops. Measured
 * at 1180x820 on the fixture below before the fix: 132 overlapping pairs in 74
 * readings taken during one scroll down and back, the worst 17px. A note whose
 * line had just left the top was pushed wholly above the pane, so it vanished
 * while part of it was still in view and was missing when the line came back.
 *
 * WHY A REAL BROWSER. Every question here is about used geometry — which box
 * overlaps which — and happy-dom lays nothing out.
 *
 * THE CONTROLS. `cards`, `beside` and the scroll height say the column really
 * drew a note for every source, the reader really scrolled past several
 * screens of them, and notes really were beside on-screen lines — so zero
 * overlaps means something. At 430 the margin is not shown, and the reading is
 * that the superscripts still carry the notes there.
 *
 * THE NUMBER. Each run shows a small superscript number and its card starts
 * with the same one, so the reader can tell which note belongs to which line.
 * `paired` reads both numbers as the browser drew them; at 430 a tap on note 3
 * opens a card that starts with 3. `lift` walks a column through the
 * painted number: it sat on the baseline (0.15) while the run's 0px font
 * made `vertical-align: super` raise it by almost nothing. `numbers` counts
 * every number painted in the prose: note 1 holds a link, which cuts its run
 * into pieces, and each piece used to paint its own copy ("2 2 2").
 *
 * ONE LINE UNTIL ASKED. With twenty-odd sources at three or four lines each
 * the margin was a wall of grey (Bryan, 2026-11-02: "way too cramped").
 * `compact` reads every caption's height at rest — one line each, with
 * `truncated` as the control that the full text would have wrapped — then
 * taps note 3's superscript, taps it again, taps caption 4 and caption 5,
 * and reads every caption after each tap. Before the change every caption
 * at rest measured several lines.
 *
 * NOTHING UNDER THE POINTER MOVES (Bryan, 2026-11-02: "don't shift the body
 * text please!"). `hover` passes the pointer over every paragraph and every
 * superscript and reads every line's box, and whether the editor replaced
 * any superscript span: lighting a note used to write a class onto the
 * editor's spans, and the editor redrew every one it was written onto.
 * `litWhileOver` is the control that the hover still lights its note.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { RUN_ID_ENV, profilesOfRun } from '../../../scripts/ui-shot-lib.ts';
import { OPEN_PROPS_FILES } from '../src/tokens-manifest.ts';
import type { FootnoteProbe } from './footnote-margin-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SRC = join(import.meta.dirname, '../src');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');
const DRIVER = join(import.meta.dirname, 'footnote-margin-driver.ts');

// audit: not-source — the sheets are INSTALLED into a real browser and the
// bundle is EXECUTED by it; every expectation in this file is a measured box.
const readText = (path: string): string => readFileSync(path, 'utf8');

const BROWSER_CASE_MS = 60_000;
const SPAWN_MS = 55_000;

const dirs: string[] = [];
const owned: string[] = [];

/** `/app/tokens.css` as the server serves it: the vendored Open Props files,
 *  then the mapping in `src/tokens.css`. The mapping alone resolves every
 *  token to nothing, which left a lit note's shade unpainted here. */
function servedTokens(): string {
  const fromPkg = createRequire(join(import.meta.dirname, '../package.json'));
  return [
    ...OPEN_PROPS_FILES.map((f) => readText(fromPkg.resolve(`open-props/${f}`))),
    readText(join(SRC, 'tokens.css')),
  ].join('\n');
}

/** The review editor's shell, as `app.ts` builds it around the doc. */
function page(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${readText(join(SRC, 'board.css'))}</style>
<style>${readText(join(SRC, 'styles.css'))}</style>
<style>${readText(join(SRC, 'doc.css'))}</style>
<style>${servedTokens()}</style>
<style>html,body{margin:0;height:100%}#shell{height:100vh;display:flex}
#editor-pane{position:relative;display:flex;flex-direction:column;flex:1;min-width:0;height:100vh}
#editor{flex:1;min-height:0;overflow:auto}</style>
</head><body>
<div id="shell">
  <aside id="set-pane"></aside>
  <main id="editor-pane"><div id="editor" class="prose"></div></main>
  <aside id="threads-pane">
    <div class="threads-tabs"><button class="tab active" data-tab="open">Open</button><button class="tab" data-tab="resolved">Resolved</button></div>
    <button id="toggle-threads">t</button><span id="threads-count"></span><button id="close-threads">x</button>
    <ol id="threads-list"></ol>
  </aside>
  <div id="threads-scrim"></div>
  <div id="doc-title"></div>
  <div id="composer" class="hidden"><div id="composer-avatar"></div><div id="composer-quote"></div><textarea id="composer-text"></textarea><button id="composer-submit">Post</button></div>
  <div id="composer-scrim" class="hidden"></div>
  <div id="thread-view" class="hidden"><button id="thread-view-close">x</button><div id="thread-view-body"></div><textarea id="thread-view-reply-text"></textarea><button id="thread-view-reply-submit">Reply</button></div>
  <button id="toggle-suggestions" class="hidden"></button><span id="suggestions-count"></span>
  <div id="suggestions-menu" class="hidden"><button id="suggestions-accept-all"></button><button id="suggestions-reject-all"></button></div>
  <div id="toast" class="hidden"></div>
</div>
<script type="module">${bundle}</script>
</body></html>`;
}

let built: string | null = null;
function buildPage(): string {
  if (built) return built;
  const dir = mkdtempSync(join(tmpdir(), 'cw-footnote-margin-'));
  dirs.push(dir);
  const bundle = join(dir, 'driver.js');
  const r = spawnSync(
    'bun',
    ['build', DRIVER, '--target', 'browser', '--format', 'esm', '--outfile', bundle],
    { encoding: 'utf8', timeout: 50_000 },
  );
  expect(r.status, r.stderr).toBe(0);
  const html = join(dir, 'doc.html');
  writeFileSync(html, page(readText(bundle)));
  built = html;
  return html;
}

/** Spawned and awaited, never blocked on, so the worker keeps answering
 *  vitest's own RPC while the browser works. */
async function measure(viewport: string[]): Promise<FootnoteProbe> {
  const html = buildPage();
  const dir = mkdtempSync(join(tmpdir(), 'cw-footnote-margin-probe-'));
  dirs.push(dir);
  const file = join(dir, 'probe.js');
  writeFileSync(file, '(async () => await window.footnoteMarginProbe())()');
  const runId = `fnm${process.pid}${owned.length}`;
  owned.push(runId);
  const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        'bun',
        [SHOT, '--url', `file://${html}`, ...viewport, '--settle', '400', '--eval-file', file],
        { timeout: SPAWN_MS, env: { ...process.env, [RUN_ID_ENV]: runId } },
      );
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
    },
  );
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse((JSON.parse(r.stdout) as { result: string }).result) as FootnoteProbe;
}

/** The body text never moves while the pointer passes over it. `crossed` and
 *  `lines` are the controls: the pointer really went over every superscript,
 *  and there were lines to watch. */
function expectStillUnderPointer(p: FootnoteProbe): void {
  expect(p.hover.crossed).toBe(p.notes);
  expect(p.hover.litWhileOver).toBe(p.notes);
  expect(p.hover.lines).toBeGreaterThan(20);
  expect(p.hover.replaced).toBe(0);
  expect(p.hover.shifted).toEqual([]);
  expect(p.hover.rawShown).toBe(0);
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const runId of owned) {
    for (const name of profilesOfRun(readdirSync(tmpdir()), runId)) {
      try {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      } catch {}
    }
  }
});

describe.skipIf(CHROME === null)('margin notes stay beside their lines while scrolling', () => {
  const wide = [
    { name: '1180x820', args: ['--preset', 'ipad'] },
    { name: '1920x1080', args: ['--size', '1920x1080'] },
  ];
  for (const { name, args } of wide) {
    it(
      `never overlaps and never drops a note whose line is in view at ${name}`,
      async () => {
        const p = await measure(args);

        // THE CONTROLS: a margin, a card for every note, several screens of
        // doc, and notes beside on-screen lines at every reading.
        expect(p.marginVisible).toBe(true);
        expect(p.notes).toBeGreaterThanOrEqual(20);
        expectStillUnderPointer(p);
        expect(p.cards).toBe(p.notes);
        // Every run shows its number, and every card starts with it.
        expect(p.superscripts).toBe(p.notes);
        expect(p.paired).toBe(p.notes);
        // ONE NUMBER PER NOTE, though a link cuts note 1 into pieces.
        expect(p.linkedPieces).toBeGreaterThanOrEqual(3);
        expect(p.numbers).toBe(p.notes);
        // …raised clear of the baseline, as a superscript is, and in the
        // text's own colour.
        expect(p.lift).toBeGreaterThan(0.3);
        expect(p.numberColour).toBe(p.textColour);
        expect(p.scrollHeight).toBeGreaterThan(2 * p.clientHeight);
        expect(p.scrolling.length).toBeGreaterThan(20);
        for (const r of [...p.scrolling, ...p.settled]) expect(r.beside).toBeGreaterThan(0);

        // THE FAULT: notes painted on top of one another mid-scroll, and at
        // rest.
        expect(p.scrolling.flatMap((r) => r.overlaps)).toEqual([]);
        expect(p.settled.flatMap((r) => r.overlaps)).toEqual([]);

        // And a note whose line is in view is in view too.
        expect(p.scrolling.flatMap((r) => r.vanished)).toEqual([]);
        expect(p.settled.flatMap((r) => r.vanished)).toEqual([]);

        // ONE LINE UNTIL ASKED: every caption at rest is one line high, and
        // most of them are cut short, so the line is doing the work.
        const c = p.compact;
        if (c === null) throw new Error('no compact reading with a margin');
        const oneLine = c.lineHeight + 1;
        expect(c.restMax).toBeLessThanOrEqual(oneLine);
        expect(c.restMin).toBeGreaterThanOrEqual(c.lineHeight - 1);
        expect(c.truncated).toBeGreaterThanOrEqual(p.notes / 2);
        // The superscript opens its caption in full, and only that one…
        expect(c.viaSuperscript.open).toBeGreaterThanOrEqual(2 * c.lineHeight);
        expect(c.viaSuperscript.othersMax).toBeLessThanOrEqual(oneLine);
        expect(c.viaSuperscript.openCount).toBe(1);
        // …a second tap closes it, and every caption is back where it was.
        expect(c.closedAgain.height).toBeLessThanOrEqual(oneLine);
        expect(c.closedAgain.openCount).toBe(0);
        expect(c.closedAgain.moved).toBeLessThan(1);
        // A caption opens itself, and opening the next one closes it.
        expect(c.viaCaption.open4).toBeGreaterThanOrEqual(2 * c.lineHeight);
        expect(c.viaCaption.then4).toBeLessThanOrEqual(oneLine);
        expect(c.viaCaption.then5).toBeGreaterThanOrEqual(2 * c.lineHeight);
        expect(c.viaCaption.openCount).toBe(1);
        expect(c.closedCaption.height).toBeLessThanOrEqual(oneLine);
        expect(c.closedCaption.openCount).toBe(0);
      },
      BROWSER_CASE_MS,
    );
  }

  it(
    'pairs a tapped number with the card it opens at 430',
    async () => {
      const p = await measure(['--preset', 'phone']);
      expect(p.marginVisible).toBe(false);
      expect(p.notes).toBeGreaterThanOrEqual(20);
      expectStillUnderPointer(p);
      expect(p.cards).toBe(0);
      expect(p.compact).toBeNull();
      expect(p.superscripts).toBe(p.notes);
      expect(p.linkedPieces).toBeGreaterThanOrEqual(3);
      expect(p.numbers).toBe(p.notes);
      expect(p.popNumber).toBe('"3"');
      // No margin, so nothing to fold: the tapped note still opens in full.
      expect(p.popHeight).toBeGreaterThanOrEqual(2 * (p.popLineHeight ?? 0));
      expect(p.lift).toBeGreaterThan(0.3);
      expect(p.numberColour).toBe(p.textColour);
    },
    BROWSER_CASE_MS,
  );
});
