/**
 * The stylesheet a recording draws with (`voice-ui.ts`), in the widget's
 * shadow root. Calm by default: nothing pulses or blinks, and the only colour
 * that means "live" is the steady red recording dot.
 */
export const VOICE_CSS = [
  '.vlive,.vcard{position:fixed;z-index:2147483647;width:280px;background:#fff;color:#1b1f23;border-radius:12px;box-shadow:0 8px 24px rgba(18,38,63,.16);font-size:14px;line-height:1.45;margin-right:var(--cw-edge)}',
  '.vlive{border:1.5px dashed #2e7dd7;overflow:hidden}',
  '.vlive.float{right:16px;bottom:calc(var(--cw-vv-bottom) + var(--cw-dock-h) + 132px)}',
  '.vhead{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #eef1f4;font:600 12px/1.2 system-ui,sans-serif;color:#6e7781}',
  '.vdot{flex:none;width:9px;height:9px;border-radius:50%;background:#d1242f}',
  '.vwhere{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1b1f23}',
  '.vwhere.seeking{color:#6e7781;font-weight:500;font-style:italic}',
  '.vlive.picking .vwhere{color:#2e7dd7}',
  '.vmove{position:relative;margin-left:auto;flex:none;min-height:28px;padding:3px 10px;border:1px solid #cfd8e3;border-radius:6px;color:#2e7dd7;font:600 12px system-ui,sans-serif;background:#fff;cursor:pointer}',
  // A finger needs 44px; the grip keeps its 28px look and takes taps around it.
  '.vmove::after{content:"";position:absolute;inset:-9px -4px}',
  '.vlive.float .vmove,.vlive.picking .vmove{display:none}',
  '.vpol{padding:9px 12px 2px;overflow-wrap:anywhere}',
  // While words are coming, they sit grey under the finished note; at the
  // pause they are folded into it and the grey line goes.
  '.vlive.hearing .vpol:empty{display:none}',
  '.vlive.quiet .vraw{display:none}',
  '.vlive.quiet .vpol{padding-bottom:4px}',
  // The note's raw words: one faded line, all of them on a tap.
  '.vkept{display:block;width:100%;text-align:left;border:0;background:none;padding:0 12px 10px;font:12px/1.45 system-ui,sans-serif;color:#a3acb5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}',
  '.vkept.open{white-space:normal;color:#8a939c}',
  '.vlive.hearing .vkept,.vlive:not(.noted) .vkept{display:none}',
  '.vcard .vtext{cursor:pointer}',
  // A phone, while talking: a dot on each earlier note's element. A tap adds to that note.
  '.vpin{position:fixed;z-index:2147483645;width:12px;height:12px;border-radius:50%;background:#2e7dd7;border:2px solid #fff;box-shadow:0 1px 4px rgba(18,38,63,.3);cursor:pointer;padding:0}',
  '.vpin::after{content:"";position:absolute;inset:-16px}',
  '.vpol:empty::before{content:"Say your feedback.";color:#a3acb5}',
  '.vraw{display:flex;flex-direction:column;justify-content:flex-end;padding:0 12px;margin:4px 0 10px;max-height:2.9em;overflow:hidden;font-size:12px;color:#8a939c;overflow-wrap:anywhere}',
  '.vcard{border:1px solid #d5dce4;padding:10px 12px}',
  '.vcard.undone .vtext{text-decoration:line-through;color:#8a939c}',
  '.vtext{overflow-wrap:anywhere}',
  '.vrawtext{margin-top:6px;font-size:12px;color:#8a939c;overflow-wrap:anywhere}',
  '.vfoot{display:flex;gap:4px;align-items:center;margin-top:8px;padding-top:4px;border-top:1px solid #eef1f4}',
  // 44px tall to a finger, 32px to the eye: the margins give the height back.
  '.vfoot button{min-height:44px;min-width:44px;margin:-6px 0;padding:0 8px;border:0;background:none;font:500 12px system-ui,sans-serif;color:#6e7781;cursor:pointer;border-radius:6px}',
  '.vfoot button:disabled{color:#c9d1d9;cursor:default}',
  '.vpager{display:none;align-items:center;font:500 12px system-ui,sans-serif;color:#6e7781}',
  '.vcard.paged .vpager{display:flex}',
  '.vfoot .vplay{color:#2e7dd7}',
  '.vfoot .vundo{margin-left:auto}',
  '.vlead{position:fixed;inset:0;pointer-events:none;z-index:2147483646}',
  '.vlead svg{width:100%;height:100%}',
  '.vlead line{stroke:#9fb9d8;stroke-width:1.2;stroke-dasharray:3 3}',
  '.vhl{position:fixed;border:2px dashed #2e7dd7;border-radius:6px;background:rgba(46,125,215,.1);pointer-events:none;z-index:2147483646}',
  // The mic is a still Stop button while recording: no animation of its own.
  '.fab-mic.voice-active .vstop{display:block;width:14px;height:14px;border-radius:3px;background:#fff}',
  '@media (max-width:1100px){.vlive,.vcard{width:auto;left:12px;right:12px}}',
].join('');
