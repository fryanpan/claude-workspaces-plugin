/**
 * The Library's recent-files tabs, driven: Recently Viewed, Recently Modified
 * and Recently Created in one row, the tab last picked kept per device, the
 * row holding still as the tab changes, Created listing board docs by when
 * each was made, and a doc made elsewhere reaching an open Recently Created
 * tab over the board's feed.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LibraryPayload } from '../src/board/library-model.ts';
import { FakeEventSource, settle } from './boot-harness.ts';
import { WS, bootTestBoard, click, el, resetBoardServer, server } from './support/board-drive.ts';
import { type DriveOptions, driveLibrary } from './support/library-drive.ts';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const PAYLOAD: LibraryPayload = {
  project: { name: 'riverbend', path: '~/dev/riverbend' },
  meetings: [],
  files: [
    { name: 'Tide gauge notes', at: NOW, created: NOW, open: 'docs/tide-gauge.md' },
    {
      name: 'Saltmarsh plan',
      at: NOW - HOUR,
      created: NOW - HOUR,
      href: `/workspaces/${WS}/docs/saltmarsh-plan`,
      docId: 'saltmarsh-plan',
    },
    // Edited just now, made two days ago.
    {
      name: 'Harborlight charter',
      at: NOW - 60_000,
      created: NOW - 48 * HOUR,
      href: `/workspaces/${WS}/docs/charter`,
      docId: 'charter',
    },
  ],
};

const drive = (opts: DriveOptions = {}) => driveLibrary(WS, PAYLOAD, NOW, opts);
const names = (root: ParentNode) =>
  [...root.querySelectorAll('.library-name')].map((n) => n.textContent);
const panelTable = (root: ParentNode, tab: string) =>
  root.querySelector(`[data-lf-panel=${tab}] > .library-tbl`) as Element;
const recentTable = (root: ParentNode) => panelTable(root, 'created');
const ALL = ['Recently Viewed', 'Recently Modified', 'Recently Created'];
const tabs = (root: ParentNode) =>
  [...root.querySelectorAll('.lf-recent-tabs [role=tab]')].map((t) => t.textContent);
const chosenTab = (root: ParentNode) =>
  root.querySelector('.lf-recent-tabs [aria-selected=true]')?.textContent;

describe('the Recently Viewed / Modified / Created tabs', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens on Recently Viewed on a device that never picked, with Created one tap away', async () => {
    const { page, root } = drive();
    await page.open();
    expect(tabs(root)).toEqual(ALL);
    expect(chosenTab(root)).toBe('Recently Viewed');
    expect(root.querySelector('[data-lf-panel=viewed]')).not.toBeNull();
    expect(root.querySelector('[data-lf-panel=created]')).toBeNull();
    await click(root.querySelector('[data-lf-tab=created]') as HTMLElement);
    expect(chosenTab(root)).toBe('Recently Created');
    expect(root.querySelector('[data-lf-panel=viewed]')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('[data-lf-tab=created]'));
  });

  it('lists recent edits under Recently Modified and board docs newest-made first under Recently Created', async () => {
    const { page, root } = drive();
    await page.open();
    await click(root.querySelector('[data-lf-tab=modified]') as HTMLElement);
    expect(chosenTab(root)).toBe('Recently Modified');
    expect(panelTable(root, 'modified').querySelector('.lf-colhead')?.textContent).toBe('Modified');
    expect(names(panelTable(root, 'modified'))).toEqual([
      'Tide gauge notes',
      'Harborlight charter',
      'Saltmarsh plan',
    ]);
    await click(root.querySelector('[data-lf-tab=created]') as HTMLElement);
    expect(recentTable(root).querySelector('.lf-colhead')?.textContent).toBe('Created');
    // The charter's edit a minute ago does not lift it: it was made two days
    // ago. The project file no doc holds has no record of being made.
    expect(names(recentTable(root))).toEqual(['Saltmarsh plan', 'Harborlight charter']);
  });

  it('keeps the tab row where it was, same labels in the same order, when the tab changes', async () => {
    const { page, root } = drive();
    await page.open();
    const body = root.querySelector('.library-body') as HTMLElement;
    const at = () => [...body.children].indexOf(root.querySelector('.lf-recent-tabs') as Element);
    const before = at();
    await click(root.querySelector('[data-lf-tab=created]') as HTMLElement);
    expect(at()).toBe(before);
    expect(tabs(root)).toEqual(ALL);
    await click(root.querySelector('[data-lf-tab=modified]') as HTMLElement);
    expect(at()).toBe(before);
    expect(tabs(root)).toEqual(ALL);
  });

  it('remembers the tab last picked on this device, and a reload opens on it', async () => {
    const first = drive();
    await first.page.open();
    await click(first.root.querySelector('[data-lf-tab=created]') as HTMLElement);
    expect(first.storage.values.get('cw-library-recent-tab')).toBe('created');
    // A reload: a fresh page over the same device storage.
    const again = drive({ storage: first.storage });
    await again.page.open();
    expect(chosenTab(again.root)).toBe('Recently Created');
    await click(again.root.querySelector('[data-lf-tab=viewed]') as HTMLElement);
    expect(again.storage.values.get('cw-library-recent-tab')).toBe('viewed');
  });

  it('opens a device that stored "created" before this change on the real Created list', async () => {
    // The old tab under the "Recently Created" label stored `created` and
    // listed by last change. That stored value now opens the list its label
    // names: board docs by when the board made each, not the newest edit.
    const { page, root } = drive({ recentTab: 'created' });
    await page.open();
    expect(chosenTab(root)).toBe('Recently Created');
    expect(recentTable(root).querySelector('.lf-colhead')?.textContent).toBe('Created');
    expect(names(recentTable(root))).toEqual(['Saltmarsh plan', 'Harborlight charter']);
  });

  it('keeps a burst opened under one tab shut under the other', async () => {
    // Three board docs written and changed seconds apart: one burst under
    // both Modified and Created, with the same newest file heading each.
    const burst: LibraryPayload = {
      ...PAYLOAD,
      files: ['quay-layout.md', 'tide-chart.md', 'ferry-flow.md'].map((name, i) => ({
        name,
        at: NOW - i * 1_000,
        created: NOW - i * 1_000,
        href: `/workspaces/${WS}/docs/b-${i}`,
        docId: `b-${i}`,
      })),
    };
    const { page, root } = driveLibrary(WS, burst, NOW, { payload: burst, recentTab: 'created' });
    await page.open();
    const head = (tab: string) =>
      panelTable(root, tab).querySelector('.library-burst-head') as HTMLElement;
    await click(head('created'));
    expect(head('created').getAttribute('aria-expanded')).toBe('true');
    await click(root.querySelector('[data-lf-tab=modified]') as HTMLElement);
    expect(head('modified').getAttribute('aria-expanded')).toBe('false');
  });

  it('moves between the tabs with the arrow keys, the chosen tab the only Tab stop', async () => {
    const { page, root } = drive();
    await page.open();
    const tab = (t: string) => root.querySelector(`[data-lf-tab=${t}]`) as HTMLElement;
    const stops = () => ['viewed', 'modified', 'created'].map((t) => tab(t).tabIndex);
    const press = (t: string, key: string) =>
      tab(t).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    expect(stops()).toEqual([0, -1, -1]);
    press('viewed', 'ArrowRight');
    expect(chosenTab(root)).toBe('Recently Modified');
    expect(document.activeElement).toBe(tab('modified'));
    expect(stops()).toEqual([-1, 0, -1]);
    press('modified', 'End');
    expect(chosenTab(root)).toBe('Recently Created');
    press('created', 'ArrowRight');
    expect(chosenTab(root)).toBe('Recently Created');
    press('created', 'ArrowLeft');
    expect(chosenTab(root)).toBe('Recently Modified');
    press('modified', 'Home');
    expect(chosenTab(root)).toBe('Recently Viewed');
    expect(document.activeElement).toBe(tab('viewed'));
  });
});

describe('the Recently Created tab on the board', () => {
  beforeEach(() => {
    resetBoardServer();
    server.on(`/workspaces/${WS}/library/items`, PAYLOAD);
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** This device last picked Recently Created. */
  const createdTab = { storage: { 'cw-library-recent-tab': 'created' } };
  const boardFeed = () => {
    const feed = [...FakeEventSource.opened]
      .reverse()
      .find((es) => es.url.endsWith(`/workspaces/${WS}/events:stream`));
    if (!feed) throw new Error('the board never opened its feed');
    return feed;
  };

  it('a doc created elsewhere reaches an open Recently Created tab, with no reload', async () => {
    await bootTestBoard({ url: `https://board.test/workspaces/${WS}/library`, ...createdTab });
    await settle();
    const lib = el('board-library');
    expect(chosenTab(lib)).toBe('Recently Created');
    expect(names(recentTable(lib))).not.toContain('Riverbend brief');
    server.on(`/workspaces/${WS}/library/items`, {
      ...PAYLOAD,
      files: [
        {
          name: 'Riverbend brief',
          at: NOW + HOUR,
          created: NOW + HOUR,
          href: `/workspaces/${WS}/docs/rb`,
          docId: 'rb',
        },
        ...PAYLOAD.files,
      ],
    });
    boardFeed().dispatchEvent(new Event('library.changed'));
    await settle();
    expect(names(recentTable(lib))[0]).toBe('Riverbend brief');
    expect(chosenTab(lib)).toBe('Recently Created');
  });
});
