import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountBoardPromptsPane } from '../src/board/board-prompts-pane.ts';
import { mountBoardSettingsView } from '../src/board/board-settings-view.ts';
import { buildShell } from '../src/board/board-shell.ts';
import type { PromptDetail, PromptRow, PromptsApi } from '../src/settings/prompts-api.ts';
import { IPAD, PHONE, type Viewport, installSheets, setViewport } from './css-harness.ts';

/**
 * Prompts is a place inside the settings page, not a way out of it.
 *
 * It was a link to `/settings/prompts` in the first cut, and the fresh-eyes
 * walk of PR 947 caught what that costs: the page next door draws a subnav
 * listing only Prompts and a rail whose Settings seat points at itself, so
 * choosing the third type stranded the reader — Board and Notifications were
 * two taps back through a browser button rather than one tap sideways.
 *
 * So these cases ask the questions a reader asks from the Prompts pane: are
 * the other two still one tap away, do the prompts actually list, and does
 * the phone's back arrow walk back up the same two steps it walked down.
 *
 * All fixtures are synthetic. The repo is public.
 */

const ROWS: PromptRow[] = [
  {
    id: 'review-item-criteria',
    name: 'What makes a good review item',
    purpose: 'The bar an agent’s ask has to clear.',
    scope: 'board',
    editable: true,
    edited: true,
  },
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    purpose: 'How a sitting is written up.',
    scope: 'server',
    editable: true,
    edited: false,
  },
];

const DETAIL: PromptDetail = {
  id: 'meeting-notes',
  name: 'Meeting notes',
  purpose: 'How a sitting is written up.',
  editable: true,
  value: '### Voice\nPlain sentences, and the decision first.',
  isDefault: true,
  default: '### Voice\nPlain sentences, and the decision first.',
};

const api: PromptsApi = {
  list: async () => ROWS,
  detail: async (id) => (id === DETAIL.id ? DETAIL : null),
  save: async () => ({ ok: true }),
};

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('board.css', 'styles.css', 'settings.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

interface Page {
  /** Choose a second-level type, the way its band's nav does. */
  choose(type: string): void;
  /** Press the topbar's back arrow. */
  back(): void;
  /** The type list is what the phone chooses from. */
  onTypeList(): boolean;
}

function settings(band: Viewport): Page {
  setViewport(band);
  const root = document.createElement('div');
  root.id = 'board-root';
  document.body.appendChild(root);
  buildShell(document, root, 'Harborlight relay', 'w-hbl');
  const host = document.getElementById('board-settings-prompts') as HTMLElement;
  const view = mountBoardSettingsView({
    document,
    narrow: () => band.width <= 1100,
    onClose: () => {},
    onNav: () => {},
    prompts: mountBoardPromptsPane({ host, api, toast: () => {} }),
  });
  document.getElementById('board-settings-view')?.classList.remove('hidden');
  view.open();
  const fire = (el: Element | null): void => {
    if (!el) throw new Error('missing control');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };
  return {
    choose: (type) =>
      fire(
        document.querySelector(
          band.width <= 1100
            ? `#board-settings-types [data-type="${type}"]`
            : `.settings-subnav a[data-type="${type}"]`,
        ),
      ),
    back: () => fire(document.getElementById('board-settings-back')),
    onTypeList: () =>
      document.getElementById('board-settings-types')?.classList.contains('hidden') === false,
  };
}

/** Poll rather than count microtasks: the pane reads before it paints, and a
 *  fixed number of ticks is a number that changes when a read grows an await. */
async function settle(test: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !test(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const shown = (id: string): boolean =>
  document.getElementById(id)?.classList.contains('hidden') === false;

describe('the Prompts pane of the board’s settings page', () => {
  it('lists the prompts without leaving the page or its nav', async () => {
    const page = settings(IPAD);
    page.choose('prompts');
    await settle(() => document.querySelectorAll('#board-settings-prompts .prompt-row').length > 0);
    expect(shown('board-settings-prompts')).toBe(true);
    expect(
      [...document.querySelectorAll('#board-settings-prompts .prompt-name')].map(
        (n) => n.textContent,
      ),
    ).toEqual(ROWS.map((r) => r.name));
    // The page's own nav is still the page's own nav: three sections, and the
    // rail's four board destinations under it.
    expect(
      [...document.querySelectorAll('.settings-subnav a[data-type]')].map((a) => a.textContent),
    ).toEqual(['Board', 'Notifications', 'Prompts']);
    expect(
      [...document.querySelectorAll('#board-settings-rail [data-nav]')].map(
        (b) => (b as HTMLElement).dataset.nav,
      ),
    ).toEqual(['home', 'tasks', 'library', 'activity']);
    expect(
      document
        .querySelector('.settings-subnav a[data-type="prompts"]')
        ?.getAttribute('aria-current'),
    ).toBe('page');
  });

  it('leaves Board one tap away', async () => {
    const page = settings(IPAD);
    page.choose('prompts');
    await settle(() => document.querySelectorAll('#board-settings-prompts .prompt-row').length > 0);
    page.choose('board');
    expect(shown('board-settings-panel')).toBe(true);
    expect(shown('board-settings-prompts')).toBe(false);
  });

  it('walks back up the same two steps on the phone', async () => {
    const page = settings(PHONE);
    expect(page.onTypeList()).toBe(true);
    page.choose('prompts');
    await settle(() => document.querySelectorAll('#board-settings-prompts .prompt-row').length > 0);
    // Down a third step: one prompt, open.
    (
      document.querySelector(
        '#board-settings-prompts [data-prompt-id="meeting-notes"]',
      ) as HTMLElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(
      () => document.querySelector('#board-settings-prompts .prompt-editor h2') !== null,
    );
    // The prompt itself, not just the level: the editor painted its name.
    expect(document.querySelector('#board-settings-prompts .prompt-editor h2')?.textContent).toBe(
      DETAIL.name,
    );
    // The arrow names the list it goes back to. The heading beside it would
    // only repeat that word, and the h2 above already names the prompt, so
    // `settings.css` drops it on this band.
    expect(document.getElementById('board-settings-back-label')?.textContent).toBe('Prompts');
    const title = document.getElementById('board-settings-title') as HTMLElement;
    expect(getComputedStyle(title).display).toBe('none');
    page.back();
    await settle(() => document.querySelectorAll('#board-settings-prompts .prompt-row').length > 0);
    expect(document.querySelector('#board-settings-prompts .prompt-editor')).toBeNull();
    // Up to the list of types, the way Board and Notifications go.
    expect(document.getElementById('board-settings-back-label')?.textContent).toBe('Settings');
    page.back();
    expect(page.onTypeList()).toBe(true);
    expect(shown('board-settings-prompts')).toBe(false);
  });

  it('draws the way back out of an open prompt above 1100 too', async () => {
    const page = settings(IPAD);
    page.choose('prompts');
    await settle(() => document.querySelectorAll('#board-settings-prompts .prompt-row').length > 0);
    const back = document.getElementById('board-settings-back') as HTMLElement;
    // Above 1100 the arrow is hidden: the rail is the way out, and there is
    // nothing above Settings to go up to.
    expect(getComputedStyle(back).display).toBe('none');
    (
      document.querySelector(
        '#board-settings-prompts [data-prompt-id="meeting-notes"]',
      ) as HTMLElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(
      () => document.querySelector('#board-settings-prompts .prompt-editor h2') !== null,
    );
    expect(document.querySelector('#board-settings-prompts .prompt-editor h2')?.textContent).toBe(
      DETAIL.name,
    );
    // An open prompt IS a step down, so now there is — and the heading beside
    // it stays on the page rather than repeating the arrow's word.
    expect(document.getElementById('board-settings-back-label')?.textContent).toBe('Prompts');
    expect(document.getElementById('board-settings-title')?.textContent).toBe('Settings');
    expect(getComputedStyle(back).display).not.toBe('none');
    page.back();
    await settle(() => document.querySelectorAll('#board-settings-prompts .prompt-row').length > 0);
    expect(getComputedStyle(back).display).toBe('none');
  });
});
