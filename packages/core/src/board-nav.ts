/**
 * The board's four pages, as every surface that links to them names them:
 * the label, the address and the glyph. The board's own rail draws them
 * (`workspaces-app/src/board/board-shell.ts`), and so does a page the app
 * bundle never loads on — the host page around a mock (`mockup-frame.ts` on
 * the server) — which is why they live here rather than in the app.
 */

export type BoardNavTab = 'home' | 'tasks' | 'library' | 'activity';

const SVG =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

export const BOARD_NAV_ICONS: Record<BoardNavTab, string> = {
  home: `<svg ${SVG}><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/></svg>`,
  tasks: `<svg ${SVG}><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>`,
  activity: `<svg ${SVG}><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>`,
  library: `<svg ${SVG}><path d="M5 4.5h9l5 5V19.5H5z"/><path d="M14 4.5v5h5"/><path d="M8.5 13h7M8.5 16.5h7"/></svg>`,
};

/** The rail's order. */
export const BOARD_NAV_TABS: ReadonlyArray<{ nav: BoardNavTab; label: string }> = [
  { nav: 'home', label: 'Home' },
  { nav: 'tasks', label: 'Tasks' },
  { nav: 'library', label: 'Library' },
  { nav: 'activity', label: 'Activity' },
];

/** Tasks is the board itself; the other three are pages under it. */
export function boardNavPath(workspaceId: string, nav: BoardNavTab): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  return nav === 'tasks' ? base : `${base}/${nav}`;
}
