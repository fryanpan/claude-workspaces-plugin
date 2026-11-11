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

import { IOS_ACCESSORY } from '../keyboard-inset.ts';

/** The agent button, in the board's dock or floated at a page's foot. */
export const BUTTON_STYLES = `
:host { all: initial; display: inline-flex; flex: none; }
:host([hidden]) { display: none; }
:host([data-placement="dock"]) { margin-left: 8px; }
:host([data-placement="float"]) { position: fixed; left: var(--lc-agent-left, 12px); bottom: calc(var(--doc-dock-h, 0px) + var(--voice-rail-lift, 0px) + 16px + var(--safe-bottom, 0px)); z-index: 900; }
button { box-sizing: border-box; width: 44px; height: 44px; margin: 0; padding: 0; border-radius: 50%; border: 1px solid var(--border, #d1d5da); background: var(--bg, #fff); color: var(--accent, #2e7dd7); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; -webkit-tap-highlight-color: transparent; }
:host([data-placement="float"]) button { box-shadow: 0 3px 9px rgba(0,0,0,.18); }
button:hover { background: var(--bg-hover, #f6f8fa); }
button:focus-visible { outline: 2px solid var(--accent, #2e7dd7); outline-offset: 2px; }
button[aria-expanded="true"] { border-color: var(--accent, #2e7dd7); }
button[data-listening="true"] { background: #c96442; border-color: #c96442; color: #fff; }
button[data-listening="true"][data-paused="true"] { background: #fff; color: #c96442; }
button { position: relative; }
button[data-meeting="true"]::after { content: ""; position: absolute; top: 2px; right: 2px; width: 8px; height: 8px; border-radius: 50%; background: #d1242f; border: 2px solid var(--bg, #fff); }
svg { display: block; width: 22px; height: 22px; pointer-events: none; }
`;

/**
 * The board row's status ring (`.board-status-mark` in `board.css`, drawn by
 * `board-island.tsx`), for a task link in a reply: the page's rule cannot
 * reach this shadow root, so its declarations are repeated here, value for
 * value. `lead-chat-task-status.test.ts` holds the two to the same computed
 * style for every status, and the browser case to the same drawn ring.
 */
export const STATUS_MARK_STYLES = `
.board-status-mark { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1.5px solid var(--fg-muted, #6e7781); border-radius: 50%; }
.board-status-mark-triage { border-style: dashed; border-color: var(--yellow, #bf8700); }
.board-status-mark-blocked { border-color: var(--fg-muted, #6e7781); }
.board-status-mark-blocked::after { content: ""; width: 8px; height: 2px; border-radius: 1px; background: var(--fg-muted, #6e7781); }
.board-status-mark-in-progress { border-color: var(--accent, #1c7ed6); }
.board-status-mark-in-progress::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--accent, #1c7ed6); }
.board-status-mark-done { border-color: var(--green, #2f9e44); background: var(--green, #2f9e44); }
.board-status-mark-done::after { content: "✓"; color: var(--bg, #fff); font-size: 11px; font-weight: 700; line-height: 1; }
.lc-md a .board-status-mark { margin-right: 5px; vertical-align: -4px; }
.ws-review-mark { display: inline-block; width: 7px; height: 7px; margin-left: 5px; border-radius: 50%; background: var(--accent, #1c7ed6); vertical-align: 0.15em; }
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
.lc-pane.lc-sheet { z-index: 2147483001; border-radius: 0; border-width: 0 0 1px; box-shadow: none; }
.lc-pane.lc-sheet.lc-keys { z-index: 2147483003; border-width: 0; }
.lc-pane.lc-sheet .lc-row-head, .lc-pane.lc-sheet .lc-tools-toggle { min-height: 44px; border-radius: 22px; }
.lc-pane.lc-sheet .lc-row-head { border-radius: 8px; }
.lc-head { flex: none; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: 44px minmax(36px, auto); grid-template-areas: "title close" "acts acts"; align-items: center; column-gap: 8px; padding: 4px 6px 6px 16px; border-bottom: 1px solid var(--border, #d1d5da); }
.lc-head > .lc-title, .lc-head > .lc-meet { grid-area: title; }
.lc-head > .lc-close { grid-area: close; }
.lc-head-acts { grid-area: acts; display: flex; align-items: center; gap: 8px; min-width: 0; }
.lc-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.lc-title h2 { flex: none; margin: 0; font-size: 15px; line-height: 20px; font-weight: 650; white-space: nowrap; }
.lc-title p { flex: 0 1 auto; min-width: 0; margin: 0; font-size: 12.5px; line-height: 16px; color: var(--fg-muted, #57606a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-icon { flex: none; width: 44px; height: 44px; margin: 0; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: 50%; background: none; color: var(--fg-muted, #57606a); cursor: pointer; }
.lc-icon:hover { background: var(--bg-hover, #f6f8fa); color: var(--fg, #1b1f23); }
.lc-icon:focus-visible, .lc-send:focus-visible, .lc-bar:focus-visible { outline: 2px solid var(--accent, #2e7dd7); outline-offset: 2px; }
.lc-icon svg { width: 20px; height: 20px; pointer-events: none; }
.lc-list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; overscroll-behavior: contain; }
.lc-empty { margin: auto 0; text-align: center; font-size: 13.5px; line-height: 1.45; color: var(--fg-muted, #57606a); }
.lc-msg { max-width: 88%; font-size: 14.5px; line-height: 1.42; white-space: pre-wrap; overflow-wrap: anywhere; }
.lc-msg-who { display: block; margin: 0 0 2px; font-size: 12px; font-weight: 600; color: var(--fg-muted, #57606a); }
.lc-msg-text { display: block; padding: 8px 11px; border-radius: 12px; }
.lc-you { align-self: flex-end; }
.lc-you .lc-msg-who { text-align: right; }
.lc-you .lc-msg-text { background: #e8f1fc; }
.lc-agent .lc-msg-text { background: #f0ece0; }
.lc-history { flex: none; margin: 0; min-height: 18px; font-size: 12px; line-height: 18px; text-align: center; color: var(--fg-muted, #57606a); }
.lc-md { white-space: normal; }
.lc-md > :first-child { margin-top: 0; }
.lc-md > :last-child { margin-bottom: 0; }
.lc-md p { margin: 0 0 8px; }
.lc-md .cm-h { margin: 10px 0 4px; font-size: 14.5px; line-height: 1.35; font-weight: 650; }
.lc-md h3.cm-h { font-size: 16px; }
.lc-md .cm-list { margin: 0 0 8px; padding-left: 22px; }
.lc-md li { margin: 2px 0; }
.lc-md a { color: var(--accent, #2e7dd7); text-decoration: underline; text-underline-offset: 2px; }
.lc-md code { padding: 1px 4px; border-radius: 4px; background: rgba(27,31,35,.07); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.lc-md pre { margin: 0 0 8px; padding: 8px 10px; border-radius: 8px; background: rgba(27,31,35,.07); overflow-x: auto; white-space: pre; }
.lc-md pre code { padding: 0; background: none; font-size: 12.5px; }
.lc-md .cm-table-wrap { margin: 0 0 8px; overflow-x: auto; }
.lc-md table { border-collapse: collapse; font-size: 13px; }
.lc-md th, .lc-md td { padding: 4px 8px; border: 1px solid rgba(27,31,35,.18); text-align: left; vertical-align: top; }
.lc-md th { font-weight: 600; }
.lc-note { display: block; margin: 3px 2px 0; font-size: 12px; color: var(--fg-muted, #57606a); }
.lc-you .lc-note { text-align: right; }
.lc-status { flex: none; min-height: 22px; padding: 2px 16px 0; font-size: 12.5px; line-height: 20px; color: var(--fg-muted, #57606a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Words being heard grow at the end, so their end stays in view: the text
   sits against the clip's right edge and runs off its left, and the empty
   ::after takes the slack so that a short line still starts at the left. */
.lc-tail { display: flex; }
.lc-tail-label { flex: none; white-space: pre; }
.lc-tail-clip { flex: 1; min-width: 0; display: flex; justify-content: flex-end; overflow: hidden; }
.lc-tail-clip::after { content: ""; flex: 1 1 0; }
.lc-tail-text { flex: none; white-space: nowrap; }
.lc-tail-clip.lc-cut { mask-image: linear-gradient(to right, transparent, #000 16px); }
.lc-compose { position: relative; flex: none; padding: 6px 8px 8px; border-top: 1px solid var(--border, #d1d5da); padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)); }
.lc-pane:not(.lc-sheet) .lc-compose { padding-bottom: 8px; }
/* Above iOS's form-accessory bar, which floats over the page's foot while a field is focused. */
.lc-pane.lc-keys .lc-compose { padding-bottom: ${8 + IOS_ACCESSORY}px; }
.lc-compose textarea { display: block; width: 100%; min-height: 40px; max-height: 132px; margin: 0; padding: 10px 14px 4px; border: 0; border-radius: 18px; background: none; color: var(--fg, #1b1f23); font: inherit; font-size: 16px; line-height: 20px; resize: none; box-sizing: border-box; }
.lc-compose textarea:focus { outline: none; }
.lc-readonly { flex: none; padding: 12px 16px; border-top: 1px solid var(--border, #d1d5da); font-size: 13px; color: var(--fg-muted, #57606a); }
.lc-pane.lc-dock { border-radius: 0; border-width: 0 0 0 1px; box-shadow: -4px 0 16px rgba(0,0,0,.06); overflow: visible; }
.lc-grip { position: absolute; left: -8px; top: 0; bottom: 0; z-index: 2; width: 16px; margin: 0; padding: 0; border: 0; background: none; cursor: col-resize; touch-action: none; }
.lc-grip::after { content: ""; position: absolute; left: 7px; top: 50%; width: 2px; height: 36px; margin-top: -18px; border-radius: 2px; background: var(--border, #d1d5da); }
.lc-grip:hover::after, .lc-grip:focus-visible::after, .lc-grip.lc-dragging::after { background: var(--accent, #2e7dd7); }
.lc-grip:focus-visible { outline: none; }
.lc-pane:not(.lc-dock) .lc-grip { display: none; }
.lc-tools-toggle { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border: 1px solid var(--border, #d1d5da); border-radius: 16px; background: var(--bg, #fff); color: var(--fg-muted, #57606a); font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.lc-tools-toggle .lc-sw { position: relative; flex: none; width: 26px; height: 16px; border-radius: 8px; background: #c8ccd1; }
.lc-tools-toggle .lc-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; }
.lc-tools-toggle[aria-pressed="true"] .lc-sw { background: var(--accent, #2e7dd7); }
.lc-tools-toggle[aria-pressed="true"] .lc-sw::after { left: 12px; }
.lc-state { display: flex; align-items: center; justify-content: flex-end; gap: 5px; margin: 3px 2px 0; font-size: 12px; white-space: normal; color: var(--fg-muted, #57606a); }
.lc-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: #c8ccd1; }
.lc-state[data-s="received"] .lc-dot { background: var(--accent, #2e7dd7); }
.lc-state[data-s="working"] .lc-dot { background: #c96442; }
.lc-state[data-s="done"] .lc-dot, .lc-state[data-s="answered"] .lc-dot { background: #2da44e; }
.lc-row { align-self: stretch; max-width: 100%; font-size: 13px; line-height: 18px; color: var(--fg, #1b1f23); }
.lc-row-head { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px; margin: 0; padding: 6px 10px; border: 1px solid var(--border, #d1d5da); border-radius: 8px; background: var(--bg, #fff); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.lc-row-head:hover { background: var(--bg-hover, #f6f8fa); }
.lc-row-head:focus-visible, .lc-tools-toggle:focus-visible, .lc-voice-btn:focus-visible { outline: 2px solid var(--accent, #2e7dd7); outline-offset: 2px; }
.lc-row-icon { flex: none; width: 16px; text-align: center; color: #2da44e; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.lc-row[data-failed="true"] .lc-row-icon { color: #d1242f; }
.lc-chan .lc-row-icon { color: var(--fg-muted, #57606a); }
.lc-row-kind { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.lc-row-sum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-muted, #57606a); }
.lc-tool .lc-row-sum { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: var(--fg, #1b1f23); }
.lc-row-chev { flex: none; width: 12px; color: var(--fg-muted, #57606a); }
.lc-row[data-open="true"] .lc-row-chev { transform: rotate(90deg); }
.lc-row-body { margin: 4px 0 0 24px; padding: 8px 10px; border-left: 2px solid var(--border, #d1d5da); font-size: 12.5px; }
.lc-row-body h4 { margin: 0 0 3px; font-size: 11.5px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--fg-muted, #57606a); }
.lc-row-body pre { margin: 0 0 8px; padding: 6px 8px; max-height: 220px; overflow-y: auto; border-radius: 6px; background: rgba(27,31,35,.06); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.lc-chan .lc-row-head { border-style: dashed; background: transparent; }
.lc-voice { align-self: flex-start; max-width: 88%; }
.lc-voice-btn { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; margin: 0; padding: 6px 14px; border: 0; border-radius: 20px; background: #f0ece0; color: var(--fg, #1b1f23); font: inherit; font-size: 13.5px; cursor: pointer; }
.lc-wave { display: inline-flex; align-items: center; gap: 2px; height: 16px; }
.lc-wave i { display: block; width: 3px; border-radius: 2px; background: rgba(27,31,35,.35); }
.lc-voice-words { min-width: 9ch; text-align: left; color: var(--accent, #2e7dd7); }
.lc-voice-text { margin-top: 4px; background: #f0ece0; }
`;
