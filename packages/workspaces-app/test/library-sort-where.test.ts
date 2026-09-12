/**
 * The Library's two mock-v2 additions, driven: the time column's header is a
 * "Last Modified" / "Created" sort, and "Where files live" sits folded shut
 * after both lists, opening onto each kind's real locations, each a tap from
 * the docs living there.
 *
 * All fixtures synthetic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LibraryPayload } from '../src/board/library-model.ts';
import { click } from './support/board-drive.ts';
import { driveLibrary } from './support/library-drive.ts';

const WS = 'w-harbor';
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const PAYLOAD: LibraryPayload = {
  project: { name: 'harborlight', path: '~/dev/harborlight' },
  meetings: [
    {
      name: 'Booking flow walkthrough',
      at: NOW - 3 * HOUR,
      created: NOW - 4 * HOUR,
      href: '/m/1',
      place: 'meetings:docs/meetings:',
    },
    {
      name: 'Kickoff',
      at: NOW - 10 * DAY,
      created: NOW - 10 * DAY,
      href: '/m/2',
      place: 'meetings:Stored by Workspaces:not in docs/meetings',
    },
  ],
  files: [
    {
      name: 'delay-alerts.md',
      at: NOW - HOUR,
      created: NOW - 20 * DAY,
      href: '/f/1',
      place: 'documents:docs:',
    },
    {
      name: 'dock-survey.md',
      at: NOW - 2 * DAY,
      created: NOW - 2 * HOUR,
      href: '/f/2',
      place: 'documents:notes:not mounted',
    },
    { name: 'README.md', at: NOW - 3 * DAY, open: 'README.md' },
  ],
  where: [
    {
      kind: 'meetings',
      unset: false,
      places: [
        { key: 'meetings:docs/meetings:', label: 'docs/meetings', folder: true, stray: false },
        {
          key: 'meetings:Stored by Workspaces:not in docs/meetings',
          label: 'Stored by Workspaces',
          folder: false,
          note: 'not in docs/meetings',
          stray: true,
        },
      ],
    },
    {
      kind: 'documents',
      unset: false,
      places: [
        { key: 'documents:docs:', label: 'docs', folder: true, stray: false },
        {
          key: 'documents:notes:not mounted',
          label: 'notes',
          folder: true,
          note: 'not mounted',
          stray: true,
        },
      ],
    },
    { kind: 'mockups', unset: false, places: [] },
  ],
};

const drive = (payload: LibraryPayload = PAYLOAD) => driveLibrary(WS, payload, NOW, { payload });

const table = (root: ParentNode, i: number) => root.querySelectorAll('.library-tbl')[i] as Element;
const cells = (root: ParentNode) =>
  [...root.querySelectorAll('.library-row')].map((r) => [
    r.querySelector('.library-name')?.textContent,
    r.querySelector('.library-when')?.textContent,
  ]);
const choose = async (select: HTMLSelectElement, value: string) => {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await Promise.resolve();
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the time column', () => {
  it('is headed "Last Modified" on both lists, a date past a week, and re-sorts by Created', async () => {
    const { page, root } = drive();
    await page.open();
    const sorts = [...root.querySelectorAll<HTMLSelectElement>('.library-sort')];
    expect(sorts.map((s) => s.selectedOptions[0]?.textContent)).toEqual([
      'Last Modified',
      'Last Modified',
    ]);
    expect([...(sorts[0] as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Last Modified',
      'Created',
    ]);
    expect(cells(table(root, 1))).toEqual([
      ['delay-alerts.md', '1h ago'],
      ['dock-survey.md', '2d ago'],
      ['README.md', '3d ago'],
    ]);
    // Ten days ago is a date, not "1w ago".
    expect(cells(table(root, 0))[1]?.[1]).not.toMatch(/ago$/);

    await choose(sorts[1] as HTMLSelectElement, 'created');
    // Newest creation first, a file with no birth time last, and the column
    // now reads the clock it is sorted by.
    expect(cells(table(root, 1))).toEqual([
      ['dock-survey.md', '2h ago'],
      ['delay-alerts.md', expect.not.stringMatching(/ago$/)],
      ['README.md', '—'],
    ]);
    const again = root.querySelector<HTMLSelectElement>('.library-sort[data-list=files]');
    expect(again?.value).toBe('created');
    expect(document.activeElement).toBe(again);
    // The other list keeps its own order.
    expect(root.querySelector<HTMLSelectElement>('.library-sort[data-list=meetings]')?.value).toBe(
      'modified',
    );
  });

  it('keeps "See all" under each list, and the full list keeps the chosen sort', async () => {
    const many: LibraryPayload = {
      ...PAYLOAD,
      meetings: Array.from({ length: 7 }, (_, i) => ({
        name: `Delay alert timing ${i + 1}`,
        at: NOW - i * HOUR,
        created: NOW - (7 - i) * HOUR,
        href: `/m/${i}`,
      })),
    };
    const { page, root } = drive(many);
    await page.open();
    expect([...root.querySelectorAll('.library-more')].map((b) => b.textContent)).toEqual([
      'See all meetings',
    ]);
    await choose(
      root.querySelector('.library-sort[data-list=meetings]') as HTMLSelectElement,
      'created',
    );
    await click(root.querySelector('.library-more[data-list=meetings]') as HTMLElement);
    expect(cells(root).map((c) => c[0])).toEqual(
      Array.from({ length: 7 }, (_, i) => `Delay alert timing ${7 - i}`),
    );
  });
});

describe('where files live', () => {
  it('is folded shut after both lists, and opens onto each kind and its locations', async () => {
    const { page, root } = drive();
    await page.open();
    const body = root.querySelector('.library-body') as HTMLElement;
    const fold = body.lastElementChild as HTMLDetailsElement;
    expect(fold.matches('details.library-where-fold')).toBe(true);
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')?.textContent).toBe('Where files live');
    // Everything the Library opened on before still comes first.
    expect([...body.querySelectorAll(':scope > h2')].map((h) => h.textContent)).toEqual([
      'Recent meetings',
      'Recent files',
    ]);

    const kinds = [...fold.querySelectorAll('.library-where-type')].map((t) => [
      t.querySelector('.library-where-name')?.textContent,
      [...t.querySelectorAll('.library-place')].map((p) =>
        [...p.querySelectorAll('.library-name, .library-place-note')]
          .map((n) => n.textContent)
          .join(' | '),
      ),
    ]);
    expect(kinds).toEqual([
      ['Meetings', ['docs/meetings', 'Stored by Workspaces | not in docs/meetings']],
      ['Documents', ['docs', 'notes | not mounted']],
      ['Mockups', ['None yet']],
    ]);
    expect(fold.querySelectorAll('.library-place-note.is-stray')).toHaveLength(2);
  });

  it('says "no folder named" for a kind the project named none for, never blank', async () => {
    const unset: LibraryPayload = {
      ...PAYLOAD,
      where: [
        {
          kind: 'meetings',
          unset: true,
          places: [
            {
              key: 'meetings:Stored by Workspaces:',
              label: 'Stored by Workspaces',
              folder: false,
              stray: false,
            },
          ],
        },
        { kind: 'documents', unset: true, places: [] },
        { kind: 'mockups', unset: false, places: [] },
      ],
    };
    const { page, root } = drive(unset);
    await page.open();
    const notes = [...root.querySelectorAll('.library-where-type')].map(
      (t) => t.querySelector('.library-place-note')?.textContent ?? null,
    );
    expect(notes).toEqual(['no folder named', 'no folder named', null]);
  });

  it('lists the docs of a tapped location, with a way back to the fold still open', async () => {
    const { page, root, history } = drive();
    await page.open();
    const fold = root.querySelector('details.library-where-fold') as HTMLDetailsElement;
    fold.open = true;
    const notes = [...root.querySelectorAll<HTMLElement>('.library-place')].find((p) =>
      p.textContent?.includes('notes'),
    );
    await click(notes as HTMLElement);
    expect(root.querySelector('.library-all h2')?.textContent).toBe('Documents · notes');
    expect(cells(root).map((c) => c[0])).toEqual(['dock-survey.md']);
    expect(history.entries.at(-1)).toMatchObject({
      kind: 'push',
      state: { libraryPlace: 'documents:notes:not mounted' },
    });
    await click(root.querySelector('.library-back') as HTMLElement);
    expect(history.entries.at(-1)).toEqual({ kind: 'back' });
    // Arriving back at the Library shows its front page with the fold as it was.
    await page.open();
    expect(root.querySelector('.library-all')).toBeNull();
    expect((root.querySelector('details.library-where-fold') as HTMLDetailsElement).open).toBe(
      true,
    );
  });
});
