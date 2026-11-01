/**
 * Home's bottom bar: Review, Inbox, Projects and Coach, at the widths a
 * workspace's navbar is a bottom bar (≤1100px). Bryan, 31 Oct: "From home can
 * you give me on mobile a navbar to go between review items, inbox, projects,
 * coach".
 *
 * Built from a workspace navbar's markup and classes — `board-nav`,
 * `board-nav-item`, `board-nav-icon`, `board-nav-label` — so the two bars
 * read as one product. Home is server-rendered and owns its own `<style>`
 * (`LANDING_CSS` in `shells.ts`), so it does not link `board.css`; the rules
 * below restate the values the board's ≤1100px block computes to, and the
 * browser test (`packages/workspaces-app/test/home-nav-browser.test.ts`)
 * reads the computed style of both bars and fails when they differ.
 *
 * The entries are plain fragment links, so a tap scrolls with no script. The
 * bar sits outside every region `landing-live.ts` swaps, and each target
 * keeps its id across a swap.
 *
 * It also holds the board's dock for the lead chat's agent button, naming the
 * board whose lead it talks to — the plan board's, Bryan's default lead —
 * which `landing-app.ts` mounts the board's own chat into. At ≤1100px it sits
 * at the bar's left end, as on a board; wider, the bar is not drawn but the
 * dock is, at the bottom left where a board's rail puts the button.
 */
import { escapeHtml } from '@claude-workspaces/core';

export interface LandingSection {
  /** The id of the section on the page the entry scrolls to. */
  id: string;
  label: string;
  icon: string;
}

/** The board's icon attributes (`BOARD_NAV_ICONS` in core), so a Home glyph
 *  has the same stroke and box as a workspace's. */
const SVG =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

const ICONS = {
  review: `<svg ${SVG}><path d="M4 5h16v11H9l-5 4z"/><path d="m9 10.5 2 2 4-4"/></svg>`,
  inbox: `<svg ${SVG}><path d="M3 13h5l1.5 3h5l1.5-3h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/></svg>`,
  projects: `<svg ${SVG}><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>`,
  coach: `<svg ${SVG}><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg>`,
} as const;

/**
 * The sections the viewer's page carries, in page order. Inbox and Coach are
 * the owner's sections, so each has an entry only when the page carries it.
 */
export function landingSections(has: { inbox: boolean; coach: boolean }): LandingSection[] {
  return [
    { id: 'landing-review', label: 'Review', icon: ICONS.review },
    ...(has.inbox ? [{ id: 'inbox', label: 'Inbox', icon: ICONS.inbox }] : []),
    { id: 'landing-boards', label: 'Projects', icon: ICONS.projects },
    ...(has.coach ? [{ id: 'coach', label: 'Coach', icon: ICONS.coach }] : []),
  ];
}

/** The bar, and the lead chat's dock when `leadBoard` names a board. Labels
 *  and ids are fixed strings, never user input; the board id is escaped. */
export function renderLandingNav(sections: readonly LandingSection[], leadBoard = ''): string {
  const dock = leadBoard
    ? `<div class="board-nav-dock" role="group" aria-label="Lead chat" data-lead-board="${escapeHtml(leadBoard)}"></div>`
    : '';
  return `<nav class="board-nav home-nav" aria-label="Sections">${sections
    .map(
      (s) =>
        `<a class="board-nav-item" href="#${s.id}"><span class="board-nav-icon" aria-hidden="true">${s.icon}</span><span class="board-nav-label">${s.label}</span></a>`,
    )
    .join('')}${dock}</nav>`;
}

/**
 * The bar's rules. Each value is what the board's ≤1100px block computes to
 * with the light tokens: `--bg-panel` #f8f9fa, `--border` #ced4da,
 * `--fg-muted` #6e7781. The widget clearance is the board's own: the comment
 * bubble's inset, its 48px and 6px of slack, so the last tab ends before it.
 * Every entry takes an equal share, so none moves or resizes.
 * `--board-bottom-bar` is the board's own name for the bar's height: the
 * coach card (`coach-card.ts`, fixed bottom-left) lifts itself by it, so it
 * sits above this bar rather than over Review items and Inbox.
 *
 * The dock's rules are the board's too: at ≤1100px its `.board-nav-dock`
 * block (first in the bar, 10px in, a divider on its right); wider, the
 * button lands where a board's rail puts it at 1180x820, 30px from the left
 * and 28px from the foot. There the coach card lifts above it by
 * `--lc-agent-room`, as it does over a floated button, and a docked chat
 * takes its width off the page's right as the board's column does.
 */
export const LANDING_NAV_CSS = `
.home-nav{display:none}
@media (min-width:1101px){
.home-nav:has(> .board-nav-dock){display:block}
.home-nav > .board-nav-item{display:none}
.home-nav > .board-nav-dock{position:fixed;left:22px;bottom:28px;z-index:60;display:flex}
html:has(.home-nav [data-lead-chat="button"]:not([hidden])){--lc-agent-room:64px}
html[data-lc-docked] body{margin-right:var(--lc-dock-w,0px)}
}
@media (max-width:1100px){
body{--board-bottom-bar:58px;padding-bottom:calc(98px + env(safe-area-inset-bottom,0px))}
body:has(claude-feedback-widget){padding-bottom:calc(132px + env(safe-area-inset-bottom,0px))}
.home-nav{display:flex;flex-direction:row;align-items:center;position:fixed;left:0;right:0;top:auto;bottom:0;z-index:60;gap:0;background:#f8f9fa;border-top:1px solid #ced4da;padding:0 0 env(safe-area-inset-bottom,0px)}
body:has(claude-feedback-widget) .home-nav{padding-right:calc(max(18px, env(safe-area-inset-right)) + 54px)}
.home-nav .board-nav-item{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:54px;padding:7px 4px 9px;font-size:11.5px;font-weight:600;line-height:1.25;color:#6e7781;text-decoration:none;white-space:nowrap;-webkit-tap-highlight-color:transparent}
.home-nav .board-nav-item:hover{color:#1b1f23;text-decoration:none}
.home-nav .board-nav-icon{flex:none;width:18px;height:18px}
.home-nav .board-nav-icon svg{display:block;width:100%;height:100%}
.home-nav .board-nav-label{max-width:100%;overflow:hidden;text-overflow:ellipsis}
.home-nav > .board-nav-dock{order:-1;display:flex;align-items:center;align-self:stretch;padding:0 10px;border-right:1px solid #ced4da}
#landing-review,#inbox,#landing-boards,#coach{scroll-margin-top:12px}
}
`;
