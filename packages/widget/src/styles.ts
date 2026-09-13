import { STATUS_COLORS } from '@claude-workspaces/core';

/**
 * Styles for the shadow-DOM portion of the widget.
 * Kept as a TS string so the build can tree-shake it into the bundle.
 *
 * The build minifies this literal on the way into the bundle (the `cssMinify`
 * plugin in `scripts/build.ts`) — comments, indentation and newlines here cost
 * the budget nothing, so write for the reader. Keep the longer notes below
 * rather than inline anyway: they are about the whole file, not one rule.
 *
 * - 44px touch floor (.icon-btn and the shared pill-button block): these are
 *   the controls a phone reviewer aims at. Unconditional rather than wrapped
 *   in a phone media query on purpose — a media query changes WHEN a rule
 *   applies, never how strongly, so a floor stated there loses to any
 *   equal-specificity rule later in this file. A floor that only ever grows
 *   a target is safe to state once, for every pointer. Asserted by
 *   tap-targets.test.ts.
 * - .auth-signin: the panel's offer, and the same control inside a composer
 *   whose draft the workspace refused — same action, same 44px target.
 * - .thread .last: full summary line even on a narrow panel — wrap instead
 *   of ellipsizing, same rule as the workspaces-app card lines; length is
 *   bounded upstream.
 */
export const widgetStyles = `
:host { all: initial; --cw-vv-bottom: 0px; --cw-dock-h: 0px; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif; }

.fab {
  position: fixed;
  right: max(18px, env(safe-area-inset-right));
  bottom: calc(var(--cw-vv-bottom) + var(--cw-dock-h) + max(18px, env(safe-area-inset-bottom)));
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #2e7dd7;
  color: #fff;
  border: 0;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0,0,0,0.22);
  z-index: 2147483647;
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 120ms ease;
}
.fab:hover { transform: scale(1.06); }
.fab-icon { display:block; line-height: 1; }
/* Mode ON swaps the bubble to a close glyph — the same button ends the mode. */
.fab .fab-icon-close { display: none; font-size: 26px; }
.fab.open .fab-icon-bubble { display: none; }
.fab.open .fab-icon-close { display: block; }
.fab.open { background: #1b1f23; }

/* The thread list's way in, above the FAB. 44px floor. */
.fab-list {
  position: fixed;
  right: max(20px, calc(env(safe-area-inset-right) + 2px));
  bottom: calc(var(--cw-vv-bottom) + var(--cw-dock-h) + max(74px, calc(env(safe-area-inset-bottom) + 74px)));
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #fff;
  color: #2e7dd7;
  border: 1px solid #d1d5da;
  cursor: pointer;
  box-shadow: 0 3px 9px rgba(0,0,0,0.18);
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
}
.fab-list:hover { border-color: #2e7dd7; }
/* The history folds away while comment mode is on — "I don't need to see the
   comment history very often" (the owner, 2026-09-11). It is the node just
   before the FAB, which wears .open while the mode is on. */
.fab-list:has(+.open) { display: none; }
.fab-list .count {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 17px;
  height: 17px;
  border-radius: 99px;
  background: ${STATUS_COLORS.open};
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}
.fab-list .count[hidden] { display: none; }

/* On a page wider than a phone, fixed boxes are laid out against the page's
   width, not the screen's: 100% - 100vw is how far the page runs past it. */
.panel {
  position: fixed;
  right: max(16px, env(safe-area-inset-right), calc(100% - 100vw + 16px));
  bottom: calc(var(--cw-vv-bottom) + var(--cw-dock-h) + max(128px, calc(env(safe-area-inset-bottom) + 128px)));
  width: 340px;
  max-height: 70vh;
  background: #fff;
  border: 1px solid #d1d5da;
  border-radius: 8px;
  box-shadow: 0 10px 36px rgba(0,0,0,0.15);
  display: none;
  flex-direction: column;
  z-index: 2147483647;
  color: #1b1f23;
  overflow: hidden;
}
.panel.open { display: flex; }

.panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid #eaeef2;
}
.panel-header .title { font-weight: 600; font-size: 13px; flex: 1; }
.status {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 99px;
  background: #f6f8fa;
  color: #6e7781;
}
.status-open, .status-open.status { background: #e8f5ed; color: ${STATUS_COLORS.resolved}; }
.status-connecting { background: #fff5dc; color: #9a6700; }
.status-closed { background: #ffe9e7; color: #a40e26; }
.icon-btn {
  background: transparent;
  border: 0;
  font-size: 18px;
  cursor: pointer;
  color: #6e7781;
  min-width: 44px;
  min-height: 44px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}
.icon-btn:hover { color: #1b1f23; }

.panel-actions {
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #eaeef2;
  background: #fafbfc;
}
.panel-actions .me { font-size: 12px; display: flex; align-items: center; gap: 6px; color: #6e7781; margin-left: auto; }
.auth-signin {
  background: #fff;
  border: 1px solid #d1d5da;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
}
.auth-signin:hover { border-color: #2e7dd7; color: #2e7dd7; }
.auth-signout {
  background: none;
  border: none;
  padding: 0;
  font-size: 11px;
  color: #6e7781;
  cursor: pointer;
  text-decoration: underline;
}
.auth-signout:hover { color: #1b1f23; }
.swatch { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
/* Pill buttons share one block; only coloring differs below. */
.primary, .cancel, .resolve, .reopen {
  background: #fff;
  border: 1px solid #d1d5da;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  min-width: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.primary { background: #2e7dd7; color: #fff; border-color: #2e7dd7; }
.primary:hover { filter: brightness(1.06); }

.panel-threads {
  padding: 6px;
  overflow-y: auto;
  flex: 1;
}
.resolved-toggle {
  display: block;
  width: calc(100% - 12px);
  margin: 8px 6px;
  padding: 6px 8px;
  background: transparent;
  border: 1px dashed #d1d5da;
  border-radius: 6px;
  color: #6e7781;
  font-size: 11px;
  cursor: pointer;
  text-align: center;
  min-height: 44px;
}
.resolved-toggle:hover { color: #1b1f23; border-color: #afb8c1; }
.section-heading {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: #6e7781;
  padding: 10px 6px 4px;
}
.thread {
  border: 1px solid #eaeef2;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 6px;
  cursor: pointer;
  background: #fff;
}
.thread:hover { border-color: #d1d5da; }
.thread.active { border-color: #2e7dd7; box-shadow: 0 0 0 2px rgba(46,125,215,0.15); }
.thread .meta {
  font-size: 11px;
  color: #6e7781;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.thread .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: ${STATUS_COLORS.open};
  display: inline-block;
}
.thread.status-resolved .dot { background: ${STATUS_COLORS.resolved}; }
.thread.status-orphan .dot { background: ${STATUS_COLORS.orphan}; }
.thread .time { margin-left: auto; color: #afb8c1; }
.thread .snippet {
  font-size: 11px;
  color: #6e7781;
  font-style: italic;
  border-left: 2px solid #eaeef2;
  padding: 2px 6px;
  margin-bottom: 4px;
  max-height: 2em;
  overflow: hidden;
}
.thread .last { font-size: 12px; color: #1b1f23; overflow-wrap: anywhere; }
.empty {
  padding: 16px 12px;
  color: #6e7781;
  font-size: 12px;
  text-align: center;
}

/* The comment card — a margin card at its element's height (placed by
   widget-card.ts, whose CARD_W is this width), and the saved comment it turns
   into on post — green edge, a brief wash, a tick. */
.composer, .saved {
  position: fixed;
  z-index: 2147483647;
  width: 280px;
  background: #fff;
  color: #1b1f23;
  border: 1px solid #d1d5da;
  border-left: 3px solid #2e7dd7;
  border-radius: 8px;
  box-shadow: 0 0 0 2px rgba(46,125,215,0.2), 0 4px 14px rgba(0,0,0,0.12);
  padding: 10px 12px;
  font-size: 13px;
}
.saved {
  border-left-color: #1f7a3a;
  box-shadow: 0 1px 4px rgba(0,0,0,0.12);
  animation: cw-saved 1.6s ease-out;
}
@keyframes cw-saved { from { background: #e8f5ed; } }
.saved-text { overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.tick { float: right; margin-left: 6px; color: #1f7a3a; font-weight: 700; font-size: 11px; }
.tick::before { content: "✓ "; }
/* "on <b>Tomatoes</b>" — one line, the name in ink. The "on" is generated so
   the line's text is the anchor's own words. */
.composer-snippet, .saved-on {
  font-size: 12px;
  color: #6e7781;
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.composer-snippet b, .saved-on b { color: #1b1f23; }
.composer-snippet b::before, .saved-on b::before { content: "on "; font-weight: 400; color: #6e7781; }
/* The faint line from a card to the element it is about. */
.leader { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
.leader svg { width: 100%; height: 100%; }
.leader polyline { fill: none; stroke: #8c959f; opacity: 0.7; }
.leader circle { fill: #8c959f; }
/* 16px at every width, or iOS zooms the page when the field takes focus,
   and the zoom moves the visual viewport the card is placed in. */
.composer textarea {
  width: 100%;
  border: 1px solid #d1d5da;
  border-radius: 6px;
  padding: 6px;
  font: inherit;
  font-size: 16px;
  resize: vertical;
}
.composer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}
.composer-err { color: #a40e26; font-size: 11px; margin-top: 6px; }

.thread-popover {
  position: fixed;
  z-index: 2147483647;
  width: 320px;
  max-height: 60vh;
  background: #fff;
  border: 1px solid #d1d5da;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  padding: 10px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.thread-popover header {
  display: flex; align-items: center; gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid #eaeef2;
  margin-bottom: 6px;
}
.thread-popover header .tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 99px;
}
.tag-open { background: #ecf3fb; color: #2e7dd7; }
.tag-resolved { background: #e8f5ed; color: ${STATUS_COLORS.resolved}; }
.tag-orphan { background: #fff5dc; color: ${STATUS_COLORS.orphan}; }
.thread-popover .snippet {
  font-size: 11px;
  font-style: italic;
  color: #6e7781;
  border-left: 2px solid #eaeef2;
  padding: 2px 6px;
  margin-bottom: 8px;
}
.thread-popover .comments {
  overflow-y: auto;
  flex: 1;
  padding-right: 2px;
  font-size: 13px;
}
.thread-popover .comment { padding: 4px 0; border-bottom: 1px solid #f6f8fa; }
.thread-popover .comment:last-child { border-bottom: 0; }
.thread-popover .author { font-size: 11px; color: #6e7781; margin-bottom: 2px; }
.thread-popover .author .swatch { margin-right: 4px; }
.thread-popover .author .time { margin-left: 6px; color: #afb8c1; }
.thread-popover .body { color: #1b1f23; }
.thread-popover .actions {
  display: flex; gap: 6px; padding-top: 8px; margin-top: 6px; border-top: 1px solid #eaeef2;
  flex-wrap: wrap;
  align-items: stretch;
}
.picker-banner {
  position: fixed;
  top: max(12px, calc(env(safe-area-inset-top) + 12px));
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  background: #1b1f23;
  color: #fff;
  padding: 8px 14px;
  border-radius: 99px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.25);
}
.picker-banner .picker-cancel {
  background: transparent;
  color: #fff;
  border: 1px solid rgba(255,255,255,0.3);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  min-width: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}
/* The phone face — the banner and the composer are both a compact panel along
   the bottom, above the dock — not a sheet, not a scrim, so the page behind
   keeps its place. After .picker-banner and .composer so it wins at equal
   specificity. The composer's panel replaces the prompt's while it is up, and
   the floating buttons it would sit on fold away. */
.quick {
  top: auto;
  left: 0;
  right: 0;
  bottom: calc(var(--cw-vv-bottom) + var(--cw-dock-h));
  width: auto;
  transform: none;
  border: 0;
  border-top: 1px solid #d1d5da;
  border-radius: 0;
  background: #fff;
  color: #6e7781;
  box-shadow: 0 -6px 20px rgba(0,0,0,0.14);
  padding: 10px 12px max(10px, env(safe-area-inset-bottom));
}
.picker-banner.quick > :first-child { flex: 1; }
.picker-banner.quick .picker-cancel { color: #1b1f23; border-color: #d1d5da; }
.picker-banner:has(~ .quick), .fab:has(~ .quick), .fab-list:has(~ .quick) { display: none; }
/* One row, shaped like the doc page's composer — a small × for Cancel at the
   far end from Post, the field as a pill, Post as a round arrow. The words
   stay in the buttons for a screen reader; only the glyphs are drawn. */
.composer.quick { display: grid; grid-template-columns: auto 1fr auto; gap: 6px; align-items: end; }
.quick .composer-actions { display: contents; }
.quick .cancel { grid-area: 1 / 1; border: 0; background: none; font-size: 0; }
.quick .cancel::before { content: "×"; font-size: 26px; color: #6e7781; }
.quick .submit { border-radius: 50%; font-size: 0; }
.quick .submit::before { content: "↑"; font-size: 20px; }
.submit:disabled { opacity: 0.5; }
/* One line that grows to four as you type, where the engine can size a
   field to its content; one line, scrolling, where it cannot. */
.quick textarea {
  grid-area: 1 / 2;
  border-radius: 22px;
  padding: 10px 14px;
  min-height: 44px;
  max-height: 96px;
  field-sizing: content;
  resize: none;
}
.quick .composer-err { grid-column: 1 / -1; }


.thread-popover .actions textarea {
  flex: 1 1 100%;
  min-width: 0;
  border: 1px solid #d1d5da;
  border-radius: 6px;
  padding: 6px;
  font: inherit;
  font-size: 12px;
  resize: vertical;
}
`;
