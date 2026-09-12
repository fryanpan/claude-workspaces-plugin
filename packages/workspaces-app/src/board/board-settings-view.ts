/**
 * The settings page of a board: its markup, and the second-level nav that
 * chooses which kind of setting is showing.
 *
 * A PAGE, not the popover it replaces (Bryan, 2026-09-11: settings reached
 * from a button at the foot of the nav rail, "so settings never crowd the
 * main tabs or the top bar"). It wears the same chrome `/settings/prompts`
 * already wears — `settings.css`'s rail, topbar, subnav and main column — so
 * the two halves of the product's settings read as one place rather than as
 * two designs that happen to share a word.
 *
 * Three types, and only two of them are panes here: Board and Notifications
 * are this board's own, and Prompts is the page next door, because five of
 * the seven prompts belong to the SERVER rather than to any one board. The
 * link leaves; it does not open a third pane that would have to fetch what
 * that page already fetches.
 *
 * Two navs, one choice: the subnav column is the tablet/desktop one and the
 * row list is the phone's, `settings.css` hiding whichever the band does not
 * use. `mountBoardSettingsView` keeps them agreeing, and answers a width
 * change so a reader is never left on a pane whose nav has just gone.
 *
 * Nothing here reads board state. The rows inside the Board pane are wired by
 * `board-settings-panel.ts` exactly as they were in the popover; this file
 * owns where they sit and which of them is on screen.
 */
import { escapeHtml } from '@claude-workspaces/core';
import { NAV_ICONS } from '../icons.ts';
import type { BoardNav } from './board-presence-model.ts';

/** Which kind of setting is showing. `null` is the phone's list of the three
 *  — a state the wide band never holds, because its subnav is always there. */
export type SettingsType = 'board' | 'notifications' | null;

const CHEV =
  '<svg class="prompt-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
const BACK =
  '<svg class="settings-rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';

/** The board's own rail, so this page sits where the board was rather than
 *  looking like a different product. Same four destinations as the board's
 *  nav, and the Settings seat at its foot is where you already are. */
function rail(): string {
  const item = (nav: BoardNav, label: string): string =>
    `<button type="button" class="settings-rail-item" data-nav="${nav}">` +
    `<span class="settings-rail-glyph" aria-hidden="true">${NAV_ICONS[nav]}</span>${escapeHtml(label)}</button>`;
  return (
    '<nav class="settings-rail" aria-label="Workspace">' +
    item('home', 'Home') +
    item('tasks', 'Tasks') +
    item('library', 'Library') +
    item('activity', 'Activity') +
    '<div class="settings-rail-spacer"></div>' +
    '<button type="button" class="settings-rail-item" aria-current="page" disabled>' +
    `<span class="settings-rail-glyph" aria-hidden="true">${NAV_ICONS.settings}</span>Settings</button>` +
    '</nav>'
  );
}

/**
 * The whole settings page, including the rows the popover used to hold.
 *
 * `#board-settings-panel` keeps its id and every row keeps its own: the
 * controls inside are read and written by `board-settings-panel.ts`, and
 * moving a control's HOME is not a reason to make its wiring look for a new
 * name.
 */
export function buildSettingsView(workspaceId: string): string {
  const promptsHref = `/settings/prompts?ws=${encodeURIComponent(workspaceId)}`;
  const typeRow = (type: string, label: string): string =>
    `<a class="prompt-row" href="#" data-type="${type}">` +
    `<span class="prompt-text"><span class="prompt-name">${escapeHtml(label)}</span></span>${CHEV}</a>`;
  return `<div id="board-settings-view" class="settings-shell board-settings-view hidden" role="region" aria-label="Settings">
      ${rail()}
      <div class="settings-page">
        <header class="settings-topbar">
          <button type="button" class="settings-back" id="board-settings-back">${BACK}<span id="board-settings-back-label">Board</span></button>
          <h1>Settings</h1>
        </header>
        <div class="settings-body-row">
          <nav class="settings-subnav" aria-label="Settings sections">
            <a href="#" data-type="board" aria-current="page">Board</a>
            <a href="#" data-type="notifications">Notifications</a>
            <!-- The way out to /settings/prompts. A link and not a pane: five
                 of the seven prompts belong to the SERVER rather than to this
                 board, so they cannot live under a per-board section. -->
            <a id="board-prompts-link" href="${promptsHref}">Prompts</a>
          </nav>
          <div class="settings-main"><div class="settings-main-inner">
            <div class="prompt-list settings-type-list" id="board-settings-types">
              ${typeRow('board', 'Board')}
              ${typeRow('notifications', 'Notifications')}
              <a class="prompt-row" id="board-prompts-row" href="${promptsHref}"><span class="prompt-text"><span class="prompt-name">Prompts</span></span>${CHEV}</a>
            </div>
            <div id="board-settings-panel" class="board-settings-panel" data-pane="board">
              <div id="board-drift" class="board-presence hidden"></div>
              <div id="board-lead" class="board-lead"></div>
              <label class="board-settings-row" for="board-done-filter">Show done tasks from
                <select id="board-done-filter" class="board-select" aria-label="Done task visibility"></select>
              </label>
              <!-- Who can reach this board, and at what level (Bryan, 2026-09-11:
                   "share a board with someone who can read and comment but cannot
                   act as him"). Everyone in the workspace can read the list — a
                   person who cannot see who else is here cannot know who reads what
                   they write — and the controls are drawn for an Owner only. The
                   enforcement is the API's: the routes behind these controls refuse
                   a Regular User with a 403 whether or not the page drew them. -->
              <div class="board-settings-row board-settings-row--members">
                <span class="board-settings-label">Who has access
                  <small id="board-members-note" class="board-settings-note"></small>
                </span>
                <div id="board-members-list" class="board-members"></div>
              </div>
              <!-- What the quality gate judges an agent's ask against, in the
                   owner's own words (Bryan, 2026-08-29: "Something we can change in
                   the settings. It's a natural language prompt."). A textarea and
                   not a rule table for that reason. It shows the DEFAULT when this
                   board has never written one, so the words are always readable
                   even when nobody has edited them — a criterion you cannot read is
                   one your agents are judged against in secret. -->
              <div class="board-settings-row board-settings-row--criteria">
                <label class="board-settings-label" for="board-review-criteria">What makes a good review item
                  <small id="board-review-criteria-note" class="board-settings-note"></small>
                </label>
                <textarea id="board-review-criteria" class="board-criteria" rows="5" aria-describedby="board-review-criteria-note" placeholder="Plain English: what an agent’s ask has to do before it reaches you."></textarea>
                <!-- The same words as plain text, for a reader the server will not
                     let write them. Drawn instead of the textarea and the actions,
                     never beside them, and carrying no caption of its own: a
                     read-only field is the value where the editor was. -->
                <p id="board-review-criteria-text" class="board-settings-readonly hidden"></p>
                <div id="board-review-criteria-actions" class="board-criteria-actions">
                  <button type="button" id="board-review-criteria-save" class="board-btn board-btn-primary">Save</button>
                  <button type="button" id="board-review-criteria-default" class="board-btn">Use the default</button>
                </div>
              </div>
              <!-- How many builders this board's lead may dispatch at once
                   (Bryan, by voice: "add support for limiting parallelism in the
                   workspace"). register_dispatch enforces the number server-side;
                   this is where it's read, changed, and shown alongside how many
                   slots are already spent. -->
              <div class="board-settings-row board-settings-row--cap">
                <label class="board-settings-label" for="board-parallelism-cap">Parallelism cap
                  <small id="board-parallelism-cap-note" class="board-settings-note"></small>
                </label>
                <input type="number" id="board-parallelism-cap" class="board-cap-input" min="1" step="1" aria-describedby="board-parallelism-cap-note" />
                <p id="board-parallelism-cap-text" class="board-settings-readonly hidden"></p>
                <div id="board-parallelism-cap-actions" class="board-criteria-actions">
                  <button type="button" id="board-parallelism-cap-save" class="board-btn board-btn-primary">Save</button>
                  <button type="button" id="board-parallelism-cap-default" class="board-btn">Use the default</button>
                </div>
              </div>
            </div>
            <div id="board-settings-notifications" class="board-settings-panel hidden" data-pane="notifications">
              <!-- Per DEVICE, not per account — a push subscription belongs to this
                   browser on this machine, so the row says so rather than reading
                   like a workspace-wide preference somebody set once. -->
              <label class="board-settings-row board-settings-row--push" for="board-push-toggle">
                <span class="board-settings-label">Notify me on this device
                  <small id="board-push-note" class="board-settings-note"></small>
                </span>
                <input type="checkbox" id="board-push-toggle" class="board-check" aria-describedby="board-push-note" />
              </label>
            </div>
          </div></div>
        </div>
      </div>
    </div>`;
}

/**
 * Put focus back on the button that is actually drawn.
 *
 * Two openers, one per band, and the hidden one is not a place to leave a
 * caret: focusing it drops a keyboard reader at the top of the document with
 * the page they just left still under them. Read as computed `display` rather
 * than `offsetParent`, which is null for everything inside a fixed ancestor.
 */
export function focusSettingsOpener(document: Document): void {
  for (const id of ['board-nav-settings', 'board-settings']) {
    const btn = document.getElementById(id);
    if (btn && document.defaultView?.getComputedStyle(btn).display !== 'none') {
      btn.focus();
      return;
    }
  }
}

export interface SettingsViewEnv {
  document: Document;
  /** True in the band where the subnav is hidden and the list is the nav.
   *  A thunk rather than a width, so the caller owns the media query. */
  narrow(): boolean;
  /** Leave settings for the board. */
  onClose(): void;
  /** Leave settings for one of the board's own pages. */
  onNav(nav: BoardNav): void;
}

export interface SettingsViewHandle {
  /** Show the page. On the wide band it opens on Board; on the phone it opens
   *  on the list of types, which is what the reader chooses from. */
  open(): void;
  /** The type showing, for tests and for the width watcher. */
  type(): SettingsType;
  /** Re-paint after a band change, so nobody is left on a pane whose nav has
   *  gone — or, on the phone, on a subnav that is no longer drawn. */
  bandChanged(): void;
}

export function mountBoardSettingsView(env: SettingsViewEnv): SettingsViewHandle {
  const { document, narrow, onClose, onNav } = env;
  const view = document.getElementById('board-settings-view');
  const back = document.getElementById('board-settings-back');
  const backLabel = document.getElementById('board-settings-back-label');
  let type: SettingsType = 'board';

  function paint(): void {
    for (const pane of document.querySelectorAll<HTMLElement>('[data-pane]')) {
      pane.classList.toggle('hidden', pane.dataset.pane !== type);
    }
    for (const link of document.querySelectorAll<HTMLElement>('.settings-subnav a[data-type]')) {
      if (link.dataset.type === type) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    // The list is the phone's nav, so it is a place the reader can be. The
    // back arrow says where it goes, which is not the same answer from the
    // list as from a pane under it.
    document.getElementById('board-settings-types')?.classList.toggle('hidden', type !== null);
    if (backLabel) backLabel.textContent = type === null ? 'Board' : 'Settings';
  }

  function setType(next: SettingsType): void {
    type = next;
    paint();
  }

  view?.addEventListener('click', (ev) => {
    const target = ev.target as Element | null;
    const typed = target?.closest?.('[data-type]') as HTMLElement | null;
    if (typed) {
      ev.preventDefault();
      setType(typed.dataset.type === 'notifications' ? 'notifications' : 'board');
      return;
    }
    const navBtn = target?.closest?.('[data-nav]') as HTMLElement | null;
    if (navBtn?.dataset.nav) onNav(navBtn.dataset.nav as BoardNav);
  });

  back?.addEventListener('click', () => {
    // One step up each press: a pane goes back to the list the phone chose it
    // from, and the list goes back to the board.
    if (type !== null && narrow()) {
      setType(null);
      return;
    }
    // Focus leaves before the page does. `onClose` hides the whole view, and
    // the button under this handler is inside it.
    focusSettingsOpener(document);
    onClose();
  });

  return {
    open(): void {
      setType(narrow() ? null : 'board');
    },
    type: () => type,
    bandChanged(): void {
      if (!narrow() && type === null) setType('board');
      else paint();
    },
  };
}
