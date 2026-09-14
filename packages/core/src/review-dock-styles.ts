import { STATUS_COLORS } from '@claude-workspaces/core';

/**
 * The review-item DOCK's shadow-DOM styles — the bar across the bottom of a
 * page carrying a standing ask, and the panel that opens from it.
 *
 * Its own module rather than another block in `styles.ts`, which was at the
 * 500-line bar: this is one self-contained surface, the only part of the
 * widget's chrome that is not the comment flow. It shares no selector with
 * anything in `styles.ts`, so appending it after that sheet costs no
 * cascade — which is what `widget.ts` does when it writes the <style>.
 *
 * The build minifies BOTH sheets (`cssMinify` in `scripts/build.ts` matches
 * `src/styles*.ts`), so comments and indentation here cost the gzip budget
 * nothing.
 */
export const dockStyles = `
/* ── The review-item dock ─────────────────────────────────────────────
   A standing ask, on the page it is about. Full width at the bottom because
   that is where the eye lands after reading the thing, and because a corner
   card at 430px either covers the mock or clips its own headline. The FAB,
   the list button and the panel all sit above it (--cw-dock-h, measured).
   Edge to edge of the SCREEN, not the page, because on a page wider than a
   phone a fixed box is laid out against the page (see --cw-edge in styles.ts). */
.cw-dock {
  position: fixed;
  left: var(--cw-vv-left);
  right: var(--cw-edge);
  bottom: var(--cw-vv-bottom);
  z-index: 2147483646;
  background: #fff;
  border-top: 1px solid #d1d5da;
  box-shadow: 0 -4px 16px rgba(0,0,0,0.10);
  padding-bottom: env(safe-area-inset-bottom);
}
.cw-dock-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 52px;
  padding: 8px max(12px, env(safe-area-inset-left)) 8px max(12px, env(safe-area-inset-right));
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  color: #1b1f23;
}
.cw-dock-ic {
  flex: 0 0 auto;
  width: 22px; height: 22px;
  border-radius: 50%;
  background: #ecf3fb;
  color: #2e7dd7;
  font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
}
.cw-dock-ic-done { background: #e8f5ed; color: ${STATUS_COLORS.resolved}; }
/* Two lines, then clipped — the headline is bounded at the door, and a bar
   that grows without limit eats the mock it is asking about. */
.cw-dock-text {
  flex: 1 1 auto;
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cw-dock-said { color: #6e7781; }
.cw-dock-round {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 99px;
  background: #f6f8fa;
  color: #6e7781;
}
.cw-dock-caret { flex: 0 0 auto; color: #afb8c1; font-size: 18px; }

/* Over the screen rather than the page, like the bar, so the item opens in
   view; its top reaches the page's, which only ever covers more. */
.cw-dock-scrim {
  position: fixed;
  top: 0;
  left: var(--cw-vv-left);
  right: var(--cw-edge);
  bottom: var(--cw-vv-bottom);
  z-index: 2147483647;
  background: rgba(27,31,35,0.32);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.cw-modal {
  width: min(520px, 100%);
  max-height: 82vh;
  background: #fff;
  border-radius: 12px 12px 0 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #1b1f23;
}
.cw-modal-head {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 6px 6px 14px;
  border-bottom: 1px solid #eaeef2;
}
.cw-modal-who { font-weight: 600; font-size: 13px; flex: 1; }
.cw-modal-scroll { overflow-y: auto; padding: 12px 14px; font-size: 13px; }
.cw-round + .cw-round { margin-top: 10px; }
.cw-round-head { font-size: 11px; color: #6e7781; display: flex; gap: 8px; }
.cw-round-headline { font-weight: 600; margin-top: 2px; }
.cw-round-body { margin: 4px 0 0; white-space: pre-wrap; }
.cw-rounds-earlier {
  border-left: 2px solid #eaeef2;
  padding-left: 10px;
  margin-bottom: 12px;
  color: #6e7781;
}
.cw-rounds-earlier summary { cursor: pointer; font-size: 12px; }
.cw-modal-answer, .cw-modal-answered {
  border-top: 1px solid #eaeef2;
  padding: 10px 14px max(10px, env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.cw-answer-choices { display: flex; flex-wrap: wrap; gap: 8px; }
.cw-answer-choices .cw-answer-opt { flex: 1 1 auto; }
.cw-modal-answer textarea {
  width: 100%;
  border: 1px solid #d1d5da;
  border-radius: 6px;
  padding: 6px;
  font: inherit;
  font-size: 13px;
  resize: vertical;
}
.cw-answer-actions { display: flex; justify-content: flex-end; }
.cw-answer-err { color: #a40e26; font-size: 11px; }
.cw-answer-err[hidden] { display: none; }
.cw-modal-answered span { color: #6e7781; }
`;
