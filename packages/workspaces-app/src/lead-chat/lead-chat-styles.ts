/**
 * The lead chat's rules, installed in its own shadow roots, so no page's
 * stylesheet reaches it and it adds no rule to any (the coach card's pattern,
 * `coach-card.ts`). Colours read the page's tokens where it has them —
 * custom properties cross a shadow boundary — and fall back to the same
 * values elsewhere, which is how the mock host, with no tokens, matches.
 *
 * Calm (CLAUDE.md): nothing pulses or blinks. Listening is a steady filled
 * button; the one movement is the bar growing into the panel, ~200ms, and
 * none under reduced motion.
 */

/** The agent button, in the board's dock or floated at a page's foot. */
export const BUTTON_STYLES = `
:host { all: initial; display: inline-flex; flex: none; }
:host([hidden]) { display: none; }
:host([data-placement="dock"]) { margin-left: 8px; }
:host([data-placement="float"]) { position: fixed; left: 12px; bottom: calc(var(--doc-dock-h, 0px) + var(--voice-rail-lift, 0px) + 16px + var(--safe-bottom, 0px)); z-index: 900; }
button { box-sizing: border-box; width: 44px; height: 44px; margin: 0; padding: 0; border-radius: 50%; border: 1px solid var(--border, #d1d5da); background: var(--bg, #fff); color: var(--accent, #2e7dd7); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; -webkit-tap-highlight-color: transparent; }
:host([data-placement="float"]) button { box-shadow: 0 3px 9px rgba(0,0,0,.18); }
button:hover { background: var(--bg-hover, #f6f8fa); }
button:focus-visible { outline: 2px solid var(--accent, #2e7dd7); outline-offset: 2px; }
button[aria-expanded="true"] { border-color: var(--accent, #2e7dd7); }
button[data-listening="true"] { background: #c96442; border-color: #c96442; color: #fff; }
button { position: relative; }
button[data-meeting="true"]::after { content: ""; position: absolute; top: 2px; right: 2px; width: 8px; height: 8px; border-radius: 50%; background: #d1242f; border: 2px solid var(--bg, #fff); }
svg { display: block; width: 22px; height: 22px; pointer-events: none; }
`;

/** The bar and the panel: one fixed layer over the page. */
export const LAYER_STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
[hidden] { display: none !important; }
.lc-bar { position: fixed; z-index: 1000; display: flex; align-items: center; gap: 8px; padding: 0 6px 0 12px; border: 1px solid var(--accent, #2e7dd7); border-radius: 12px; background: var(--bg, #fff); color: var(--fg, #1b1f23); box-shadow: 0 4px 16px rgba(27,31,35,.12); cursor: pointer; text-align: left; font: inherit; }
.lc-bar-lines { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
.lc-bar-line { display: block; min-height: 17px; font-size: 13px; line-height: 17px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-bar-line b { font-weight: 600; }
.lc-bar-line.lc-dim { color: var(--fg-muted, #57606a); }
.lc-pane { position: fixed; z-index: 1000; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border, #d1d5da); border-radius: 14px; background: var(--bg, #fff); color: var(--fg, #1b1f23); box-shadow: 0 8px 28px rgba(0,0,0,.14); }
.lc-pane.lc-sheet { z-index: 2147483001; border-radius: 14px 14px 0 0; }
.lc-head { flex: none; display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 6px 6px 6px 16px; border-bottom: 1px solid var(--border, #d1d5da); }
.lc-title { flex: 1; min-width: 0; }
.lc-title h2 { margin: 0; font-size: 15px; line-height: 20px; font-weight: 650; }
.lc-title p { margin: 0; font-size: 12.5px; line-height: 16px; color: var(--fg-muted, #57606a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-icon { flex: none; width: 44px; height: 44px; margin: 0; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: 50%; background: none; color: var(--fg-muted, #57606a); cursor: pointer; }
.lc-icon:hover { background: var(--bg-hover, #f6f8fa); color: var(--fg, #1b1f23); }
.lc-icon:focus-visible, .lc-send:focus-visible, .lc-bar:focus-visible { outline: 2px solid var(--accent, #2e7dd7); outline-offset: 2px; }
.lc-icon svg { width: 20px; height: 20px; pointer-events: none; }
.lc-icon[aria-pressed="true"] { background: #c96442; border-color: #c96442; color: #fff; }
.lc-list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; overscroll-behavior: contain; }
.lc-empty { margin: auto 0; text-align: center; font-size: 13.5px; line-height: 1.45; color: var(--fg-muted, #57606a); }
.lc-msg { max-width: 88%; font-size: 14.5px; line-height: 1.42; white-space: pre-wrap; overflow-wrap: anywhere; }
.lc-msg-who { display: block; margin: 0 0 2px; font-size: 12px; font-weight: 600; color: var(--fg-muted, #57606a); }
.lc-msg-text { display: block; padding: 8px 11px; border-radius: 12px; }
.lc-you { align-self: flex-end; }
.lc-you .lc-msg-who { text-align: right; }
.lc-you .lc-msg-text { background: #e8f1fc; }
.lc-agent .lc-msg-text { background: #f0ece0; }
.lc-note { display: block; margin: 3px 2px 0; font-size: 12px; color: var(--fg-muted, #57606a); }
.lc-you .lc-note { text-align: right; }
.lc-status { flex: none; min-height: 22px; padding: 2px 16px 0; font-size: 12.5px; line-height: 20px; color: var(--fg-muted, #57606a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-compose { flex: none; display: flex; align-items: flex-end; gap: 6px; padding: 6px 8px 8px 12px; border-top: 1px solid var(--border, #d1d5da); padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)); }
.lc-pane:not(.lc-sheet) .lc-compose { padding-bottom: 8px; }
.lc-compose textarea { flex: 1; min-width: 0; min-height: 44px; max-height: 132px; margin: 0; padding: 11px 12px; border: 1px solid var(--border, #d1d5da); border-radius: 10px; background: var(--bg, #fff); color: var(--fg, #1b1f23); font: inherit; font-size: 16px; line-height: 20px; resize: none; }
.lc-compose textarea:focus { outline: 2px solid var(--accent, #2e7dd7); outline-offset: -1px; border-color: var(--accent, #2e7dd7); }
.lc-send { flex: none; min-width: 64px; height: 44px; margin: 0; padding: 0 14px; border: 1px solid var(--accent, #2e7dd7); border-radius: 10px; background: var(--accent, #2e7dd7); color: #fff; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.lc-send:disabled { opacity: .5; cursor: default; }
.lc-readonly { flex: none; padding: 12px 16px; border-top: 1px solid var(--border, #d1d5da); font-size: 13px; color: var(--fg-muted, #57606a); }
`;
