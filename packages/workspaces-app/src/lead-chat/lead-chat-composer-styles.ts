/**
 * The composer's styles, in the chat's shadow root beside `LAYER_STYLES`.
 * Controls are 40px so a thumb lands on them, and the row keeps its size
 * whatever the chip says.
 */
export const COMPOSER_STYLES = `
.lc-box { border: 1px solid var(--border, #d1d5da); border-radius: 18px; background: var(--bg, #fff); }
.lc-box:focus-within { border-color: var(--accent, #2e7dd7); }
.lc-compose.lc-drag .lc-box { outline: 2px dashed var(--accent, #2e7dd7); outline-offset: 2px; }
.lc-tray { display: flex; gap: 8px; padding: 10px 10px 0; overflow-x: auto; }
.lc-tray[hidden] { display: none; }
.lc-att { position: relative; flex: none; width: 56px; height: 56px; border: 1px solid var(--border, #d1d5da); border-radius: 10px; overflow: hidden; background: #f6f8fa; }
.lc-att-up img { opacity: .5; }
.lc-att img { display: block; width: 100%; height: 100%; object-fit: cover; }
.lc-att-file { display: flex; flex-direction: column; justify-content: center; width: 132px; padding: 0 26px 0 10px; font-size: 12px; line-height: 16px; }
.lc-att-file b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-att-file .lc-att-note { color: var(--fg-muted, #57606a); }
.lc-att-x { position: absolute; top: 2px; right: 2px; width: 22px; height: 22px; margin: 0; padding: 0; border: 0; border-radius: 50%; background: rgba(27,31,35,.7); color: #fff; font-size: 13px; line-height: 22px; cursor: pointer; }
.lc-actions { display: flex; align-items: center; gap: 6px; padding: 4px 6px 6px; }
.lc-grow { flex: 1; min-width: 0; }
.lc-round { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; margin: 0; padding: 0; border: 1px solid var(--border, #d1d5da); border-radius: 50%; background: var(--bg, #fff); color: var(--fg, #1b1f23); cursor: pointer; }
.lc-round svg { width: 20px; height: 20px; pointer-events: none; }
.lc-round:disabled { opacity: .45; cursor: default; }
.lc-send { border-color: var(--accent, #2e7dd7); background: var(--accent, #2e7dd7); color: #fff; }
.lc-mic[aria-pressed="true"] { border-color: #c96442; background: #c96442; color: #fff; }
.lc-chip { flex: 0 1 170px; display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 40px; margin: 0; padding: 0 12px; border: 1px solid var(--border, #d1d5da); border-radius: 20px; background: var(--bg, #fff); color: var(--fg, #1b1f23); font: inherit; font-size: 13.5px; white-space: nowrap; overflow: hidden; cursor: pointer; }
.lc-eff { color: var(--fg-muted, #57606a); }
.lc-round:focus-visible, .lc-chip:focus-visible, .lc-pick:focus-visible, .lc-tile:focus-visible { outline: 2px solid var(--accent, #2e7dd7); outline-offset: 2px; }
.lc-scrim { position: absolute; inset: 0; z-index: 5; background: rgba(27,31,35,.28); }
.lc-scrim[hidden], .lc-rise[hidden] { display: none; }
.lc-rise { position: absolute; left: 0; right: 0; bottom: 0; z-index: 6; max-height: 86%; overflow-y: auto; padding: 8px 14px calc(16px + env(safe-area-inset-bottom, 0px)); border-radius: 16px 16px 0 0; background: var(--bg, #fff); box-shadow: 0 -6px 24px rgba(0,0,0,.14); }
.lc-rise-head { display: flex; align-items: center; justify-content: space-between; min-height: 44px; }
.lc-rise-head h3 { margin: 0; font-size: 15px; font-weight: 650; }
.lc-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 4px 0 8px; }
.lc-tile { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; min-height: 72px; margin: 0; padding: 0; border: 1px solid var(--border, #d1d5da); border-radius: 12px; background: #f6f8fa; color: var(--fg, #1b1f23); font: inherit; font-size: 13.5px; cursor: pointer; }
.lc-tile svg { width: 22px; height: 22px; }
.lc-why { margin: 4px 0 10px; font-size: 13px; line-height: 1.45; color: var(--fg-muted, #57606a); }
.lc-pick { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 48px; margin: 0; padding: 8px 10px; border: 0; border-top: 1px solid var(--border, #d1d5da); background: none; color: var(--fg, #1b1f23); font: inherit; font-size: 14.5px; text-align: left; cursor: pointer; }
.lc-sub { display: block; font-size: 12.5px; color: var(--fg-muted, #57606a); }
.lc-tick { visibility: hidden; flex: none; width: 18px; color: var(--accent, #2e7dd7); font-weight: 700; }
.lc-pick[aria-checked="true"] .lc-tick { visibility: visible; }
.lc-label { margin: 10px 0 6px; font-size: 12px; font-weight: 600; color: var(--fg-muted, #57606a); }
.lc-seg { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; margin: 0 0 10px; padding: 3px; border-radius: 12px; background: #eef1f4; }
.lc-seg button { min-height: 38px; margin: 0; padding: 0; border: 0; border-radius: 9px; background: none; color: var(--fg, #1b1f23); font: inherit; font-size: 13px; cursor: pointer; }
.lc-seg button[aria-checked="true"] { background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.12); font-weight: 600; }
.lc-thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 4px; }
.lc-you .lc-thumbs { justify-content: flex-end; }
.lc-thumbs img { display: block; width: 120px; height: 90px; border: 1px solid var(--border, #d1d5da); border-radius: 10px; object-fit: cover; }
.lc-sent-file { display: flex; flex-direction: column; justify-content: center; max-width: 180px; min-height: 44px; padding: 4px 10px; border-radius: 10px; background: #e8f1fc; color: var(--fg, #1b1f23); font-size: 12px; line-height: 16px; text-decoration: none; }
.lc-sent-file b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;
