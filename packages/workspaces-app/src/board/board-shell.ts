/**
 * The board page's static shell: the markup `bootBoard` paints once into
 * `#board-root`, and the nav glyphs it is drawn with.
 *
 * One responsibility — the DOM that exists before any region renders. It is
 * the one piece of `board-app.ts` that never sees `main()`'s closure: it takes
 * a document, a root, a name and a workspace id, and returns nothing but the
 * containers every `render*` writes into. That is why it can live here while
 * the render layer cannot — nothing in this file can reach `state`, so a
 * change to the shell cannot quietly become a change to the board.
 *
 * `wireNavCollapse` sits here rather than in the boot for the same reason
 * the markup does: it is entirely about the rail — the class the rail wears,
 * the glyph and label the button swaps to, and the one stored preference
 * that makes the choice survive a reload. Nothing in it reads board state
 * either.
 */
import { escapeHtml } from '@claude-workspaces/core';
import { MIC_ICON, NAV_ICONS } from '../icons.ts';
// Defines <meeting-banner>, rendered by buildShell at the top of the board
// column. Import for the side effect; the element manages itself.
import '../meeting-banner.ts';
import { DEFAULT_DONE_WINDOW, DONE_WINDOWS } from './board-model.ts';
import type { BoardNav } from './board-presence-model.ts';
import { buildSettingsView } from './board-settings-view.ts';

/** Where the collapse choice is remembered — `bootBoard`'s injected
 *  `localStorage`, so a test can hand it a plain map. */
export interface NavCollapseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The nav, in the order it renders. Four destinations and nothing else: the
 *  settings button below them is not a page of the workspace, so it is not
 *  one of these. */
const NAV_ITEMS: ReadonlyArray<{ nav: BoardNav; label: string; icon: string }> = [
  { nav: 'home', label: 'Home', icon: NAV_ICONS.home },
  { nav: 'tasks', label: 'Tasks', icon: NAV_ICONS.tasks },
  { nav: 'library', label: 'Library', icon: NAV_ICONS.library },
  { nav: 'activity', label: 'Activity', icon: NAV_ICONS.activity },
];

/**
 * The back arrow, or nothing.
 *
 * `/` is the all-workspaces page, and on a share or collaboration hostname it
 * is not a page at all: the host guard refuses every path that names no
 * workspace, so the arrow landed a visitor on a raw JSON refusal. A member was
 * given one board; there is nowhere above it for them to go, so the arrow is
 * left out rather than pointed somewhere it does not belong.
 *
 * The server sets `data-visitor` on `#board-root` — it is the only side that
 * knows which hostname class served the page.
 */
function backLink(root: HTMLElement): string {
  if (root.dataset.visitor === '1') return '';
  return '<a href="/" class="back-link" title="All workspaces" aria-label="Back">←</a>';
}

/** Static shell — built once; regions re-render into their containers. */
export function buildShell(
  document: Document,
  root: HTMLElement,
  name: string,
  workspaceId: string,
): void {
  root.innerHTML = `
    <header class="board-topbar">
      ${backLink(root)}
      <span class="board-ws-name"><span class="board-ws-name-text" id="board-ws-name-text">${escapeHtml(name)}</span><span id="board-retired-badge" class="board-retired-badge hidden">Retired</span></span>
      <div class="board-cluster">
        <div id="board-people" class="board-presence board-people hidden"></div>
        <button type="button" id="board-share" class="board-icon-btn" title="Share workspace" aria-label="Share workspace">${NAV_ICONS.share}</button>
        <button type="button" id="board-settings" class="board-icon-btn" title="Workspace settings" aria-label="Workspace settings">${NAV_ICONS.settings}<span id="board-settings-alarm" class="board-alarm-dot hidden" aria-hidden="true"></span></button>
        <button type="button" id="board-me" class="board-me" title="Signed in" aria-haspopup="true" aria-expanded="false"></button>
      </div>
      <div id="board-me-menu" class="board-me-menu hidden" role="region" aria-label="Your identity"></div>
    </header>
    <div id="board-connection" class="conn-banner hidden" role="status" aria-live="polite"></div>
    <div class="board-main" id="board-main">
      <nav id="board-nav" class="board-nav" aria-label="Workspace pages">
        ${NAV_ITEMS.map(
          (
            n,
          ) => `<button type="button" class="board-nav-item" data-nav="${n.nav}" title="${escapeHtml(n.label)}">
          <span class="board-nav-icon" aria-hidden="true">${n.icon}</span><span class="board-nav-label">${escapeHtml(n.label)}</span>
        </button>`,
        ).join('')}
        <button type="button" id="board-nav-collapse" class="board-nav-item board-nav-collapse" title="Collapse">
          <span class="board-nav-icon" aria-hidden="true">${NAV_ICONS.collapse}</span><span class="board-nav-label">Collapse</span>
        </button>
        <div class="board-nav-dock" role="group" aria-label="Voice">
          <button type="button" id="board-mic" class="voice-mic" title="Hold to talk (or hold Space)" aria-label="Hold to talk">${MIC_ICON}</button>
          <div id="board-voice" class="voice-indicator hidden" aria-live="polite"></div>
        </div>
      </nav>
      <section id="board-home" class="board-home hidden">
        <!-- The banner again, for the pane landing links open on: the board
             column's copy is display:none here, and a live "Bot in call" —
             the only pull-out surface — must not be. Its own instance with
             its own poll; the two panes never show at once. -->
        <meeting-banner workspace-id="${escapeHtml(workspaceId)}"></meeting-banner>
        <div id="board-home-page">
          <div id="board-home-review"></div>
          <div id="board-home-activity"></div>
          <div id="board-home-brief"></div>
        </div>
        <div id="board-walkthrough" class="board-walkthrough hidden"></div>
      </section>
      <section class="board-col">
        <!-- The calendar meeting offer, IN FLOW at the top of the content
             (approved mockup, round 4): header bar, then this, then the New
             task row — pushed-down content, never an overlay. Hidden with the
             whole column on the Home pane. -->
        <meeting-banner workspace-id="${escapeHtml(workspaceId)}"></meeting-banner>
        <div id="board-decisions" class="board-decisions hidden"></div>
        <div id="board-quick" class="board-quick"></div>
        <div id="board" class="board"></div>
        <div id="board-archived" class="board hidden"></div>
        <div id="board-activity" class="board-activity hidden"></div>
        <div id="board-library" class="board-library hidden"></div>
      </section>
    </div>
    <div id="board-detail" class="board-detail hidden"></div>
    <!-- The GOAL panel's own container. It used to share #board-detail with the
         task panel and rebuild it with replaceChildren, which no vanilla code
         may do to a node holding a live island — same resolution the archived
         list got when the board became one. -->
    <div id="board-goal-detail" class="board-detail hidden"></div>
    <div id="board-help" class="board-help hidden">
      <div class="board-help-card">
        <h2>Keyboard shortcuts</h2>
        <dl>
          <dt>j / k</dt><dd>next / previous task</dd>
          <dt>o or Enter</dt><dd>open the focused task</dd>
          <dt>s</dt><dd>open the focused task's status dropdown</dd>
          <dt>a</dt><dd>open the focused task's assignee picker</dd>
          <dt>e</dt><dd>archive the focused task — it leaves the board, and a 10-second Undo offers it back. Nothing is destroyed; the archived list restores it later</dd>
          <dt>r or F2</dt><dd>rename the focused task in place — clicking its title does the same, with the cursor where you clicked</dd>
          <dt>alt + ↑ / ↓</dt><dd>move the focused task up / down — past the ends of its goal it moves into the next one</dd>
          <dt>tab to ⠿, then ↑ / ↓</dt><dd>the same move from the drag handle</dd>
          <dt>c</dt><dd>new task — an empty row opens in the panel with the title ready to type</dd>
          <dt>?</dt><dd>toggle this help</dd>
        </dl>
      </div>
    </div>
    <div id="board-toast" class="board-toast hidden"></div>
    ${buildSettingsView(workspaceId)}`;
  const doneSelect = document.getElementById('board-done-filter') as HTMLSelectElement;
  for (const w of DONE_WINDOWS) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.label;
    doneSelect.append(opt);
  }
  doneSelect.value = DEFAULT_DONE_WINDOW;
}

/**
 * The rail's collapse toggle, persisted so the choice survives reloads.
 *
 * Call once, from boot. The button only renders on wide screens (CSS hides
 * it in the strip and bottom-bar bands), so on a phone this wires nothing
 * and the stored preference is simply not consulted.
 */
export function wireNavCollapse(document: Document, storage: NavCollapseStorage): void {
  const NAV_COLLAPSED_KEY = 'cw-board-nav-collapsed';
  const nav = document.getElementById('board-nav');
  const collapseBtn = document.getElementById('board-nav-collapse');
  const apply = (collapsed: boolean) => {
    nav?.classList.toggle('board-nav--collapsed', collapsed);
    if (collapseBtn) {
      const icon = collapseBtn.querySelector('.board-nav-icon');
      if (icon) icon.innerHTML = collapsed ? NAV_ICONS.expand : NAV_ICONS.collapse;
      const label = collapseBtn.querySelector('.board-nav-label');
      if (label) label.textContent = collapsed ? 'Expand' : 'Collapse';
      collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
    }
  };
  apply(storage.getItem(NAV_COLLAPSED_KEY) === '1');
  collapseBtn?.addEventListener('click', () => {
    const next = !nav?.classList.contains('board-nav--collapsed');
    storage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
    apply(next);
  });
}
