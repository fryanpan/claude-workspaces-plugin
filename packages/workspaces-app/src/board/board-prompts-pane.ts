/**
 * Prompts, as a pane of the board's settings page.
 *
 * It used to be a link out to `/settings/prompts`, and that was a dead end
 * (UX review of PR 947): the page next door draws a subnav listing only
 * Prompts and a rail whose Settings seat points at itself, so choosing the
 * third type left the settings page and stranded the reader two taps from
 * Board and Notifications. A type in a nav has to be a place inside the thing
 * the nav belongs to.
 *
 * So the words live here now, under the same rail and the same subnav as the
 * other two. Nothing about WHERE they are stored moved: five of the seven
 * prompts belong to the server and two to the board, and `prompts-api.ts`
 * still hides that split behind the same three questions. This module owns
 * only the pane's own two levels — the list, and one prompt open — and the
 * page's topbar reads that level to draw its arrow and its heading.
 *
 * `/settings/prompts` is unchanged and still its own address: it is the page
 * for a reader who arrived without a board, which this pane cannot be.
 */
import { mountPromptEditor } from '../settings/prompt-editor.ts';
import type { PromptsApi } from '../settings/prompts-api.ts';
import { promptRow } from '../settings/prompts-page.ts';

export interface BoardPromptsPaneDeps {
  /** Where the pane paints. Owned by this module while it is mounted. */
  host: HTMLElement;
  api: PromptsApi;
  /** The board's one-line report, which the editor writes its saves to. */
  toast(message: string): void;
}

export interface BoardPromptsPaneHandle {
  /** Show the list of prompts. The level resets before the read lands, so a
   *  caller may paint the topbar in the same turn. */
  showList(): void;
  /** The prompt open in the pane, or null at the list. */
  openPrompt(): string | null;
  /** One step up inside the pane. False at the list, where the step up is
   *  the settings page's own and not this pane's. */
  back(): boolean;
}

export function mountBoardPromptsPane(deps: BoardPromptsPaneDeps): BoardPromptsPaneHandle {
  const { host, api, toast } = deps;
  let openId: string | null = null;

  async function paintList(): Promise<void> {
    const rows = await api.list();
    // A failed read says so rather than drawing an empty list: seven rows and
    // none is a difference the reader has to be able to see.
    host.innerHTML = rows
      ? `<div class="prompt-list">${rows.map((row) => promptRow(row, '#')).join('')}</div>`
      : '<div class="prompt-list"><p>Could not read the prompts.</p></div>';
  }

  async function paintPrompt(id: string): Promise<void> {
    host.replaceChildren();
    await mountPromptEditor({ host, api, id, toast }).refresh();
  }

  host.addEventListener('click', (ev) => {
    const row = (ev.target as Element | null)?.closest?.('[data-prompt-id]') as HTMLElement | null;
    const id = row?.dataset.promptId;
    if (!id) return;
    // `href="#"` on every row: the pane has no address of its own, and a bare
    // anchor is what `settings.css` draws a row as.
    ev.preventDefault();
    // Set before the paint is awaited, so the page's topbar — which repaints
    // from this same click, after this handler — reads the level it is about
    // to be on rather than the one it is leaving.
    openId = id;
    void paintPrompt(id);
  });

  return {
    showList(): void {
      openId = null;
      void paintList();
    },
    openPrompt: () => openId,
    back(): boolean {
      if (openId === null) return false;
      openId = null;
      void paintList();
      return true;
    },
  };
}
