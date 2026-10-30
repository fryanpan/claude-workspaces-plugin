import { STATUS_COLORS } from '@claude-workspaces/core/ui-shared';

/**
 * The comment view's rules, added to the widget's shadow root by
 * `widget-page-list.ts`. They sit on top of the budgeted bundle's panel rules
 * (`styles.ts`), which is why the panel's place and size are restated here
 * rather than changed there: this sheet ships in `mic.js` and
 * `mockup-live.js`, outside the bundle's gzip ceiling.
 *
 * Wider than 1100px the view is a 420px column down the right edge; at 1100
 * and under it is a sheet over the lower 82% of the screen, and a thread
 * opened from it fills a sheet of half the screen on its own, so the page
 * above still shows what the thread is about. One colour, `MARK`, marks
 * comments everywhere: the pins, the dots in the list and the link badges.
 */

/** The one comment colour, which the pins take from the same constant. */
export const MARK = STATUS_COLORS.open;

export const VIEW_CSS = [
  '.panel{top:0;right:0;bottom:0;width:420px;max-height:none;border-radius:0;border-width:0 0 0 1px;margin-right:0;box-shadow:-8px 0 28px rgba(0,0,0,.10)}',
  '@media (max-width:1100px){.panel{top:auto;left:0;width:auto;height:82%;border-width:1px 0 0;border-radius:12px 12px 0 0;box-shadow:0 -8px 28px rgba(0,0,0,.16)}.panel.cw-detail{height:50%}}',
  '.panel-header .cw-sub{font-size:12px;color:#6e7781;flex:1;font-weight:400}',
  '.panel-header .title{flex:0 0 auto}',
  // The way in sits in the board's top bar around a mock (`mock-host.ts`).
  ':host([data-cw-host-bar]) .fab-list:not(.fab-mic){display:none}',
  // The page row: one chip per page, the page you are on outlined, a steady
  // dot (never a count) on a page holding something new. A chip keeps its
  // width whether or not it holds something new.
  '.cw-pages{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid #eaeef2;overflow-x:auto;background:#fafbfc;flex:0 0 auto}',
  '.cw-pchip{flex:0 0 auto;min-height:36px;padding:0 12px;border-radius:99px;border:1px solid #d1d5da;background:#fff;font-size:12px;color:#1b1f23;cursor:pointer;display:inline-flex;align-items:center;gap:6px}',
  '.cw-pchip.here{border-color:#2e7dd7;color:#2e7dd7;box-shadow:inset 0 0 0 1px #2e7dd7}',
  '.cw-pchip .n{color:#6e7781}',
  `.cw-newdot{display:inline-block;width:8px;height:8px;border-radius:50%;background:${MARK};flex:0 0 auto}`,
  '.cw-newdot[hidden]{display:inline-block;visibility:hidden}',
  '.panel.cw-detail .cw-pages,.panel.cw-detail .panel-actions{display:none}',
  '.panel-threads{padding:4px 8px 72px}',
  '.section-heading{display:flex;align-items:baseline;gap:6px;padding:14px 6px 6px}',
  '[data-section=new] .section-heading{color:#1f2328}',
  '.section-heading .where{text-transform:none;letter-spacing:0;font-weight:400;margin:0;font-size:10px}',
  '.section-heading .go{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:500;color:#2e7dd7;background:none;border:0;font-size:11px;cursor:pointer;min-height:32px}',
  '.thread .where{font-size:11px;color:#6e7781;margin-top:4px}',
  '.cw-none{font-size:11px;color:#6e7781;padding:0 6px 6px}',
  `.thread .dot{background:${MARK}}`,
  '.thread{padding:10px 12px;margin-bottom:8px}',
  '.thread .snippet{max-height:none}',
  '.cw-c{padding:6px 0}',
  '.cw-c+.cw-c{border-top:1px solid #f3f4f6}',
  '.cw-c .author{font-size:11px;color:#6e7781;margin-bottom:2px;display:flex;align-items:center;gap:5px}',
  '.cw-c .author b{color:#1b1f23;font-weight:600}',
  '.cw-c .author .time{margin-left:auto}',
  '.cw-c .body{font-size:13px;line-height:1.4;color:#1b1f23;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}',
  '.cw-more{display:block;width:100%;text-align:left;background:none;border:0;border-top:1px dashed #eaeef2;border-bottom:1px dashed #eaeef2;color:#2e7dd7;font-size:12px;min-height:36px;cursor:pointer;padding:0}',
  // The thread opened in full: the popover's own body, drawn in the card.
  '.thread.active{cursor:default}',
  '.thread .thread-popover{position:static;width:auto;max-height:none;box-shadow:none;border:0;padding:0;margin:0;z-index:auto}',
  '.thread .thread-popover>header,.thread .thread-popover>.snippet{display:none}',
  '.thread .thread-popover .comments{max-height:none}',
  '.cw-back{display:none}',
  '.panel.cw-detail .cw-back{display:flex;align-items:center;border-bottom:1px solid #eaeef2;margin:0 -8px 4px;padding:0 4px}',
  '.cw-back button{min-height:44px;min-width:44px;padding:0 12px;border:0;background:none;color:#2e7dd7;font-size:14px;font-weight:600;cursor:pointer}',
  // A linked review item: a steady marked row in the thread (calm rule).
  '.cw-linked{margin:8px 0 4px;border:1px solid #c8dcf3;border-left:3px solid #2e7dd7;background:#f4f8fd;border-radius:6px;padding:8px 10px;display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:center}',
  '.cw-linked .from{grid-column:1/-1;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#2e7dd7}',
  '.cw-linked .hl{font-size:13px;font-weight:600;color:#1b1f23;line-height:1.35;overflow-wrap:anywhere}',
  '.cw-linked a{grid-column:2;grid-row:2;min-height:44px;min-width:44px;padding:0 12px;border-radius:6px;border:1px solid #2e7dd7;background:#fff;color:#2e7dd7;font-size:12px;font-weight:600;white-space:nowrap;display:inline-flex;align-items:center;text-decoration:none}',
].join('');

/** In the page's own sheet: pins and link badges are drawn in the light DOM. */
export const PAGE_CSS = [
  // The steady ring on the pin being shown, until the next tap on the page.
  '.cfw-pin[data-hl]:after{content:"";position:absolute;left:5px;top:2px;width:34px;height:34px;box-sizing:border-box;border-radius:50%;border:3px solid #2e7dd7}',
  '.cfw-pin[data-hl]{opacity:1}',
  `.cw-link-badge{position:fixed;width:20px;height:20px;border-radius:50%;background:${MARK};color:#fff;border:2px solid #fff;box-sizing:border-box;font:700 11px/16px system-ui,sans-serif;text-align:center;pointer-events:none;z-index:2147483646}`,
  // Wide, a mock in the board narrows beside the open view rather than
  // running under it.
  '@media (min-width:1101px){html.cw-view-open{width:calc(100% - 420px)!important;overflow-x:hidden}}',
].join('');
