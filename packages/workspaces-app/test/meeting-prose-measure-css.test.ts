import { spawnSync } from 'node:child_process';
/**
 * The measure holds still while a meeting runs.
 *
 * In the 2026-09-09 huddle the meeting page went narrow mid-meeting — "just
 * wide enough for the notes" — while the note-taker was writing. The cause was
 * not any of the three max-widths on this surface. `#editor > .ProseMirror`
 * centres with `margin: 0 auto`, and an auto INLINE margin on a grid item makes
 * the item size to fit-content rather than stretch to its area, so inside the
 * balloon-margin grid (`#editor.redline-layout`) the prose was as wide as its
 * widest LINE. An ordinary doc hides that — its paragraphs run long enough that
 * fit-content reaches the whole column — but a meeting doc starts empty and
 * fills with short bullets, and the measured collapse was 824px to 393px at
 * 1180x820 while the transcript beside it stayed 824.
 *
 * WHY THIS RUNS A REAL BROWSER. happy-dom resolves no layout — `css-harness.ts`
 * says so — and the whole of this bug is a used-size the cascade never names:
 * every declaration involved reads exactly the same before and after the fix.
 * A stylesheet regex could not see it and neither can a computed-style read;
 * only a measured width can, which is what testing standard 1 asks for and
 * what `bun run ui:shot` provides.
 *
 * The scenario carries its own control. Each viewport also reports
 * `proseIfAutoSized` — the same DOM with the definite width taken back off —
 * so a run in which the notes happened to be long enough to fill the column
 * anyway fails HERE rather than passing the real assertions vacuously.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CHROME_BIN, RUN_ID_ENV, profilesOfRun } from '../../../scripts/ui-shot-lib.ts';
import { BALLOON_ROOM_QUERY, BALLOON_SHEET_QUERY } from '../src/card-placement.ts';

const CHROME = process.env.CW_CHROME_BIN ?? DEFAULT_CHROME_BIN;
const SRC = join(import.meta.dirname, '../src');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');

/**
 * The sheets the review shell links, in its own order.
 *
 * audit: not-source — the text is INSTALLED into a real browser and never
 * asserted on; every expectation below is a measured pixel width, so a renamed
 * selector or a reworded declaration can neither pass nor fail a case here.
 */
const sheet = (name: string): string => readFileSync(join(SRC, name), 'utf8');

/**
 * The review editor as the meeting mounts it: the balloon-margin grid, the
 * prose, the margin column and the live zone that `doc-meeting-mount.ts`
 * appends after the prose.
 */
function page(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${sheet('styles.css')}</style>
<style>${sheet('doc.css')}</style>
<style>${sheet('tokens.css')}</style>
<style>html,body{margin:0}#editor-pane{position:relative;display:flex;flex-direction:column;height:100vh}</style>
</head><body>
<section id="editor-pane">
  <div id="editor" class="prose redline-layout">
    <div class="ProseMirror" contenteditable="true"><p><br></p></div>
    <div class="markup-margin"></div>
    <div class="live-zone" hidden><div class="lz-head"><span>Live</span></div><div class="lz-lines"></div></div>
  </div>
</section>
</body></html>`;
}

/** What the page runs: the meeting, in three steps, measured at each one. */
const PROBE = `(() => {
  // The placement the app would publish at this width, by its own two
  // queries (card-placement.ts) — nothing is stored in a throwaway profile,
  // so this is the DEFAULT path a first-time reader takes.
  const placement = matchMedia(${JSON.stringify(BALLOON_ROOM_QUERY)}).matches ? 'balloon' : 'inline';
  const noRoomAtAll = matchMedia(${JSON.stringify(BALLOON_SHEET_QUERY)}).matches;
  document.body.dataset.cards =
    placement === 'inline' ? 'inline' : noRoomAtAll ? 'sheet' : 'balloon';

  const prose = document.querySelector('.ProseMirror');
  const zone = document.querySelector('.live-zone');
  const margin = document.querySelector('.markup-margin');
  const w = (el) => Math.round(el.getBoundingClientRect().width);
  const out = { cards: document.body.dataset.cards };

  out.emptyDoc = w(prose);

  // The meeting opens: the transcript zone appears under the prose, carrying a
  // long unbroken run of speech.
  zone.hidden = false;
  zone.querySelector('.lz-lines').textContent =
    'so the thing I keep coming back to is that we never wrote down what the acceptance bar was for that, and it kept biting us every week when the numbers came back different from what the dashboard said';
  out.zoneShown = w(prose);
  out.zoneWidth = w(zone);

  // The first notes land — short lines, the way a note-taker writes them.
  prose.innerHTML =
    '<ul><li><p>Acceptance bar was never written down</p></li><li><p>Dashboard and the weekly numbers disagree</p></li></ul>';
  out.afterNotes = w(prose);
  out.marginWidth = w(margin);
  out.paneWidth = w(document.getElementById('editor'));
  const editorStyle = getComputedStyle(document.getElementById('editor'));
  out.editorDisplay = editorStyle.display;
  out.editorPad = Math.round(Number.parseFloat(editorStyle.paddingLeft));

  // The reader who chose reading width still gets it.
  document.body.classList.add('is-reading-width');
  out.readingWidth = w(prose);
  document.body.classList.remove('is-reading-width');

  // The scenario's own control: with the definite width taken back off, the
  // prose sizes to fit-content again. If this reads the same as afterNotes the
  // notes were long enough to fill the column and the case proves nothing.
  prose.style.width = 'auto';
  out.proseIfAutoSized = w(prose);
  prose.style.width = '';

  return JSON.stringify(out);
})()`;

interface Reading {
  cards: string;
  emptyDoc: number;
  zoneShown: number;
  zoneWidth: number;
  afterNotes: number;
  marginWidth: number;
  paneWidth: number;
  editorDisplay: string;
  editorPad: number;
  readingWidth: number;
  proseIfAutoSized: number;
}

/**
 * A launch plus a load is 4-6s on this machine and vitest's default case
 * budget is 5s, so the default loses to load rather than to the assertion.
 * The same reason `scripts/ui-shot.test.ts`'s browser block carries one.
 */
const BROWSER_CASE_MS = 60_000;

const owned: string[] = [];
const dirs: string[] = [];

function measure(preset: 'ipad' | 'phone'): Reading {
  const dir = mkdtempSync(join(tmpdir(), 'cw-measure-'));
  dirs.push(dir);
  const html = join(dir, 'meeting.html');
  writeFileSync(html, page());
  const probe = join(dir, 'probe.js');
  writeFileSync(probe, PROBE);
  const runId = `measure${process.pid}${owned.length}`;
  owned.push(runId);
  const r = spawnSync(
    'bun',
    [SHOT, '--url', `file://${html}`, '--preset', preset, '--settle', '250', '--eval-file', probe],
    { encoding: 'utf8', timeout: 90_000, env: { ...process.env, [RUN_ID_ENV]: runId } },
  );
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse((JSON.parse(r.stdout) as { result: string }).result) as Reading;
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

describe.skipIf(!existsSync(CHROME))('the meeting page keeps its width while notes arrive', () => {
  it(
    'holds the prose measure through the zone and the first notes at 1180x820',
    () => {
      const m = measure('ipad');

      // Controls: this is the balloon grid, and the margin column really is in
      // it. Without both, a prose that filled the pane would satisfy everything
      // below while proving nothing about the grid the bug lived in.
      expect(m.cards).toBe('balloon');
      expect(m.editorDisplay).toBe('grid');
      expect(m.marginWidth).toBe(260);
      expect(m.editorPad).toBe(40);
      expect(m.paneWidth).toBe(1180);

      // The scenario is live: sized to its content, the prose would collapse to
      // the widest bullet — well under the column it sits in.
      expect(m.proseIfAutoSized).toBeLessThan(m.afterNotes - 200);

      // The measure itself: one width, before the meeting, once the transcript
      // is on screen, and after the notes land.
      // The whole column: the pane less its side padding, the margin and the gap.
      expect(m.emptyDoc).toBe(m.paneWidth - 2 * m.editorPad - m.marginWidth - 16);
      expect(m.emptyDoc).toBe(824);
      expect(m.zoneShown).toBe(m.emptyDoc);
      expect(m.afterNotes).toBe(m.emptyDoc);

      // The transcript and the notes share one left edge and one measure.
      expect(m.zoneWidth).toBe(m.afterNotes);

      // A reader who chose reading width still gets it — 36rem at 18px.
      expect(m.readingWidth).toBe(576);
    },
    BROWSER_CASE_MS,
  );

  it(
    'holds the prose measure at 430 too, where the cards move into the flow',
    () => {
      const m = measure('phone');

      // Control: with no room for a margin the default placement puts the cards
      // in the flow and the grid becomes a block, so this width exercises the
      // other branch of the same rule rather than repeating the first case.
      expect(m.cards).toBe('inline');
      expect(m.editorDisplay).toBe('block');
      expect(m.paneWidth).toBe(430);

      // The whole pane less its side padding, which steps down on a phone.
      expect(m.editorPad).toBe(14);
      expect(m.emptyDoc).toBe(m.paneWidth - 2 * m.editorPad);
      expect(m.emptyDoc).toBe(402);
      expect(m.zoneShown).toBe(m.emptyDoc);
      expect(m.afterNotes).toBe(m.emptyDoc);
      expect(m.zoneWidth).toBe(m.afterNotes);

      // Reading width asks for 36rem and the pane has less, so the pane wins:
      // the choice never introduces a horizontal scroll on a phone.
      expect(m.readingWidth).toBe(m.emptyDoc);
    },
    BROWSER_CASE_MS,
  );
});
