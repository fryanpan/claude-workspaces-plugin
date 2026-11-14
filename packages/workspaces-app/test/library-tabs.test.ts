/**
 * The Library's recent-files tabs, driven: Recently Viewed and Recently
 * Created in one row, the tab last picked kept per device, the row holding
 * still as the tab changes, and a doc made elsewhere reaching an open
 * Recently Created tab over the board's feed.
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
    },
  ],
};

const drive = (opts: DriveOptions = {}) => driveLibrary(WS, PAYLOAD, NOW, opts);
const names = (root: ParentNode) =>
  [...root.querySelectorAll('.library-name')].map((n) => n.textContent);
const recentTable = (root: ParentNode) =>
  root.querySelector('[data-lf-panel=created] > .library-tbl') as Element;
const tabs = (root: ParentNode) =>
  [...root.querySelectorAll('.lf-recent-tabs [role=tab]')].map((t) => t.textContent);
const chosenTab = (root: ParentNode) =>
  root.querySelector('.lf-recent-tabs [aria-selected=true]')?.textContent;

describe('the Recently Viewed / Recently Created tabs', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens on Recently Viewed on a device that never picked, with Created one tap away', async () => {
    const { page, root } = drive();
    await page.open();
    expect(tabs(root)).toEqual(['Recently Viewed', 'Recently Created']);
    expect(chosenTab(root)).toBe('Recently Viewed');
    expect(root.querySelector('[data-lf-panel=viewed]')).not.toBeNull();
    expect(root.querySelector('[data-lf-panel=created]')).toBeNull();
    await click(root.querySelector('[data-lf-tab=created]') as HTMLElement);
    expect(chosenTab(root)).toBe('Recently Created');
    expect(names(recentTable(root))[0]).toBe('Tide gauge notes');
    expect(root.querySelector('[data-lf-panel=viewed]')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('[data-lf-tab=created]'));
  });

  it('keeps the tab row where it was, same labels in the same order, when the tab changes', async () => {
    const { page, root } = drive();
    await page.open();
    const body = root.querySelector('.library-body') as HTMLElement;
    const at = () => [...body.children].indexOf(root.querySelector('.lf-recent-tabs') as Element);
    const before = at();
    await click(root.querySelector('[data-lf-tab=created]') as HTMLElement);
    expect(at()).toBe(before);
    expect(tabs(root)).toEqual(['Recently Viewed', 'Recently Created']);
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

  it('moves between the tabs with the arrow keys, the chosen tab the only Tab stop', async () => {
    const { page, root } = drive();
    await page.open();
    const tab = (t: string) => root.querySelector(`[data-lf-tab=${t}]`) as HTMLElement;
    expect([tab('viewed').tabIndex, tab('created').tabIndex]).toEqual([0, -1]);
    tab('viewed').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(chosenTab(root)).toBe('Recently Created');
    expect(document.activeElement).toBe(tab('created'));
    expect([tab('viewed').tabIndex, tab('created').tabIndex]).toEqual([-1, 0]);
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
