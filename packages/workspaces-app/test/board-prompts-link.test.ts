import { afterEach, describe, expect, it } from 'vitest';
import { buildShell } from '../src/board/board-shell.ts';

/**
 * The way from the board to the prompts page.
 *
 * The board's settings panel is where a reader goes looking for anything
 * configurable, so the way to the prompts page has to be in it — and it has
 * to carry the board along, because the page's rail and its two board-scoped
 * rows have nothing to point at without one.
 *
 * There is no matching "way back" test because there is no special way back:
 * every row on the prompts page is edited on the prompts page, so nothing
 * over there deep-links into this panel. The page's own back arrow is a plain
 * link to the board, covered in `prompt-settings-page.test.ts`.
 *
 * All fixtures are synthetic. The repo is public.
 */

afterEach(() => {
  document.body.innerHTML = '';
});

function board(): { root: HTMLElement; workspaceId: string } {
  const root = document.createElement('div');
  root.id = 'board-root';
  document.body.appendChild(root);
  const workspaceId = 'w-Test123';
  buildShell(document, root, 'Demo board', workspaceId);
  return { root, workspaceId };
}

describe('the way to the prompts page', () => {
  it('is a row in the board’s settings panel, carrying the board', () => {
    const { root, workspaceId } = board();
    const link = root.querySelector('#board-prompts-link') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent?.trim()).toBe('Prompts');
    // Without ?ws the page has no rail and no board-scoped rows.
    expect(link.getAttribute('href')).toBe(
      `/settings/prompts?ws=${encodeURIComponent(workspaceId)}`,
    );
  });

  it('sits in the settings page’s section nav, not loose in the topbar', () => {
    const { root } = board();
    const link = root.querySelector('#board-prompts-link') as HTMLAnchorElement;
    // Prompts is one of the settings page's three sections, and a link that
    // escaped that nav would still pass the assertion above while sitting
    // somewhere nobody looks.
    expect(link.closest('.settings-subnav')).not.toBeNull();
    expect(link.closest('#board-settings-view')).not.toBeNull();
    // The phone's nav is the row list, and it carries the same address.
    const row = root.querySelector('#board-prompts-row') as HTMLAnchorElement;
    expect(row.getAttribute('href')).toBe(link.getAttribute('href'));
  });
});
