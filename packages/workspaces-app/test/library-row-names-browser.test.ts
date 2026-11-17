/**
 * A Library row's name gets every pixel the row does not need for its fixed
 * parts.
 *
 * Bryan's report, from his phone: "Names cut off too early. Give them a lot
 * more room." At 430 the Meetings folder showed "Meetin…" beside a note that
 * kept its room, two long folder names were cut with a wide empty gap between
 * the count and the ⋯, and a doc's name stopped well short of its "5h ago".
 * Two rules did that. Every row carried the 104px time column, folders
 * included, where it was always empty; and in a doc row the time sat in that
 * 104px, right-aligned, so the name lost whatever "5h ago" did not fill.
 *
 * So, measured here: a cut name ends at the next fixed part (the count, the
 * time, the ⋯) with only the row's own gap between them; the count, the time
 * and the ⋯ are never cut; and the meetings note gives way before the name.
 *
 * WHY A REAL BROWSER. Every question is a used width. happy-dom lays nothing
 * out (`css-harness.ts` says so). The rows are the real renderers' output —
 * `createLibraryTree` and `fixedTable` — so a markup change moves the test
 * too, and the sheets are the real three in the board's link order.
 *
 * All fixtures synthetic: Harborlight, Riverbend and Saltmarsh are place names.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { RUN_ID_ENV, profilesOfRun } from '../../../scripts/ui-shot-lib.ts';
import type { LibraryFolder, LibraryPayload, LibraryRow } from '../src/board/library-model.ts';
import { fixedTable } from '../src/board/library-recent.ts';
import { createLibraryStars } from '../src/board/library-starred.ts';
import { createLibraryTree } from '../src/board/library-tree.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SRC = join(import.meta.dirname, '../src');
const SHOT = join(import.meta.dirname, '../../../scripts/ui-shot.ts');

// audit: not-source — the sheets are INSTALLED into a real browser; nothing
// below asserts on their text, and every expectation is a measured pixel.
const readText = (path: string): string => readFileSync(path, 'utf8');

const BROWSER_CASE_MS = 60_000;
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const FOLDERS: LibraryFolder[] = [
  {
    id: 'meet',
    name: 'Harborlight Council Meetings and Hearings',
    parentId: null,
    path: 'm',
    meetings: true,
  },
  { id: 'short', name: 'Saltmarsh', parentId: null, path: 's' },
  {
    id: 'long',
    name: 'Riverbend Area Plans and Low-Traffic Neighbourhood Streets',
    parentId: null,
    path: 'l',
  },
];

const DOC: LibraryRow = {
  name: 'Whitepaper Part 1: What Do Riverbend Residents Want From Their Streets',
  docId: 'd-paper',
  at: NOW - 5 * HOUR,
  href: '/workspaces/ws/docs/d-paper',
};

/** The Library's real rows: Recently Viewed's table, then the folder tree. */
function libraryHtml(): string {
  const send = async () => ({ ok: true, status: 200, data: null });
  const noop = () => {};
  const stars = createLibraryStars({
    workspaceId: 'ws',
    send,
    viewer: () => null,
    rerender: noop,
    toast: noop,
    now: () => NOW,
  });
  const tree = createLibraryTree({
    root: document.createElement('div'),
    workspaceId: 'ws',
    send,
    toast: noop,
    refresh: async () => {},
    rerender: noop,
    bind: async () => null,
    now: () => NOW,
    stars,
  });
  const payload: LibraryPayload = {
    project: { name: 'harborlight', path: '~/dev/harborlight' },
    meetings: [],
    files: [{ ...DOC, folderId: 'long' }],
    folders: FOLDERS,
  };
  tree.load(payload, 'modified');
  const recent = fixedTable('Last Modified', tree.rowHtml(DOC, { clock: 'modified' }), '');
  return recent + tree.html();
}

function page(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<style>${readText(join(SRC, 'board.css'))}</style>
<style>${readText(join(SRC, 'styles.css'))}</style>
<style>${readText(join(SRC, 'tokens.css'))}</style>
</head><body class="board-body">
<div id="board-root"><div id="board-main" class="board-main">
  <section class="board-col"><div class="board-library"><div class="library-page">
    <div class="library-body">${libraryHtml()}</div>
  </div></div></section>
</div></div>
</body></html>`;
}

/** One row, measured. `gapAfterName` is the empty run from the name's right
 *  edge to the left edge of the next thing that shows ink. */
interface RowReading {
  nameWidth: number;
  nameCut: boolean;
  gapAfterName: number;
  /** Characters of the name that fit before the ellipsis. */
  shownChars: number;
  totalChars: number;
  countCut: boolean;
  whenCut: boolean;
  moreWidth: number;
  hintWidth: number;
  /** From the last thing before the ⋯ (count, note or time) to the ⋯'s box. */
  gapBeforeMore: number;
}
type Rows = Record<'doc' | 'meet' | 'short' | 'long', RowReading> & { rowGap: number };
/** The rows as they render, and again under the rules main shipped. */
interface Reading {
  now: Rows;
  control: Rows;
}

/** THE CONTROL: the three rules as they stood before this branch, put back
 *  over the page. A probe that measured nothing fails here, not by passing. */
const BEFORE_CSS = `
.lf-tbl .library-row, .lf-tbl .lf-folder {
  grid-template-columns: minmax(0, 1fr) 104px var(--lf-more-w) !important;
}
.lf-folder > .library-when { display: block !important; }
.lf-landhint { flex: 0 1000 auto !important; }`;

const PROBE = `(() => {
  const ink = (el) => {
    // The box of the text inside el, not of el: a right-aligned time inside a
    // wide column starts where its text starts.
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect();
  };
  const canvas = document.createElement('canvas').getContext('2d');
  const shown = (el) => {
    const cs = getComputedStyle(el);
    canvas.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    const text = el.textContent;
    if (el.scrollWidth <= el.clientWidth) return text.length;
    const room = el.clientWidth - canvas.measureText('…').width;
    let n = 0;
    while (n < text.length && canvas.measureText(text.slice(0, n + 1)).width <= room) n++;
    return n;
  };
  const read = (row) => {
    const name = row.querySelector('.library-name');
    const n = name.getBoundingClientRect();
    const next = [row.querySelector('.lf-count'), row.querySelector('.library-when'), row.querySelector('.lf-more')]
      .filter((el) => el && el.textContent.trim())
      .map((el) => ink(el).left)
      .filter((x) => x >= n.right - 1);
    const count = row.querySelector('.lf-count');
    const when = row.querySelector('.library-when');
    const hint = row.querySelector('.lf-landhint');
    return {
      nameWidth: Math.round(n.width),
      nameCut: name.scrollWidth > name.clientWidth,
      gapAfterName: Math.round(Math.min(...next) - n.right),
      shownChars: shown(name),
      totalChars: name.textContent.length,
      countCut: !!count && count.scrollWidth > count.clientWidth,
      whenCut: !!when && when.scrollWidth > when.clientWidth,
      moreWidth: Math.round(row.querySelector('.lf-more').getBoundingClientRect().width),
      hintWidth: hint ? Math.round(hint.getBoundingClientRect().width) : 0,
      gapBeforeMore: Math.round(
        row.querySelector('.lf-more').getBoundingClientRect().left -
          Math.max(...[name, count, hint, when].filter(Boolean).map((el) => {
            const b = el === when ? ink(el) : el.getBoundingClientRect();
            return b.width > 0 ? b.right : -Infinity;
          })),
      ),
    };
  };
  const folder = (id) => read(document.querySelector('[data-lf-folder="' + id + '"]'));
  const all = () => ({
    doc: read(document.querySelector('.lf-doc')),
    meet: folder('meet'),
    short: folder('short'),
    long: folder('long'),
    rowGap: parseFloat(getComputedStyle(document.querySelector('.lf-doc')).columnGap),
  });
  const now = all();
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(BEFORE_CSS)};
  document.head.append(style);
  const control = all();
  style.remove();
  return JSON.stringify({ now, control });
})()`;

const dirs: string[] = [];
const owned: string[] = [];

function measure(preset: 'ipad' | 'phone', html: string): Reading {
  const dir = mkdtempSync(join(tmpdir(), 'cw-library-names-'));
  dirs.push(dir);
  const file = join(dir, 'library.html');
  writeFileSync(file, html);
  const probe = join(dir, 'probe.js');
  writeFileSync(probe, PROBE);
  const runId = `libnames${process.pid}${owned.length}`;
  owned.push(runId);
  const args = [SHOT, '--url', `file://${file}`, '--preset', preset, '--settle', '250'];
  if (process.env.CW_LIBRARY_NAMES_SHOT_DIR) {
    args.push('--out', join(process.env.CW_LIBRARY_NAMES_SHOT_DIR, `library-names-${preset}.png`));
  }
  const r = spawnSync('bun', [...args, '--eval-file', probe], {
    encoding: 'utf8',
    timeout: 50_000,
    env: { ...process.env, [RUN_ID_ENV]: runId },
  });
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

describe.skipIf(CHROME === null)('Library row names at 430', () => {
  let r: Reading;
  let m: Rows;
  beforeAll(() => {
    r = measure('phone', page());
    m = r.now;
  }, BROWSER_CASE_MS);

  it('keeps the fixed parts whole: count, time and ⋯', () => {
    for (const row of [m.doc, m.meet, m.short, m.long]) {
      expect(row.countCut).toBe(false);
      expect(row.whenCut).toBe(false);
      expect(row.moreWidth).toBe(44);
    }
  });

  it('runs a cut folder name up to its count, and the count up to the ⋯', () => {
    expect(m.long.nameCut, 'the fixture is long enough to be cut').toBe(true);
    expect(m.long.gapAfterName).toBeLessThanOrEqual(8);
    // Nothing but the row's own gap between the count and the ⋯: no empty
    // time column in a row that has no time.
    expect(m.long.gapBeforeMore).toBeLessThanOrEqual(m.rowGap + 2);
    expect(r.control.long.gapBeforeMore, 'control').toBeGreaterThan(100);
    expect(m.long.shownChars).toBeGreaterThan(r.control.long.shownChars);
  });

  it('gives a doc row the room up to its time', () => {
    expect(m.doc.nameCut, 'the fixture is long enough to be cut').toBe(true);
    expect(m.doc.gapAfterName).toBeLessThanOrEqual(m.rowGap + 2);
    expect(r.control.doc.gapAfterName, 'control').toBeGreaterThan(m.rowGap + 30);
    expect(m.doc.shownChars).toBeGreaterThan(r.control.doc.shownChars);
  });

  it('lets the meetings note give way before the name', () => {
    expect(m.short.nameCut).toBe(false);
    // A long meetings name takes the row as a plain folder's does; the note
    // gets what is left, which here is nothing.
    expect(m.meet.nameCut).toBe(true);
    expect(m.meet.hintWidth).toBeLessThanOrEqual(1);
    expect(m.meet.nameWidth).toBeGreaterThanOrEqual(m.long.nameWidth - 10);
    // And it shows more of the name than main did, by a margin.
    expect(m.meet.shownChars).toBeGreaterThan(r.control.meet.shownChars + 8);
  });
});

describe.skipIf(CHROME === null)('Library row names at 1180x820', () => {
  let m: Rows;
  beforeAll(() => {
    m = measure('ipad', page()).now;
  }, BROWSER_CASE_MS);

  it('shows every fixture name whole, with the count, time and ⋯ whole beside it', () => {
    for (const row of [m.doc, m.meet, m.short, m.long]) {
      expect(row.nameCut).toBe(false);
      expect(row.countCut).toBe(false);
      expect(row.whenCut).toBe(false);
      expect(row.moreWidth).toBe(44);
    }
    // The note shows when there is room for it.
    expect(m.meet.hintWidth).toBeGreaterThan(100);
  });
});
