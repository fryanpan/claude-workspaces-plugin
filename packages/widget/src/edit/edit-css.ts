/**
 * Edit mode's two sheets, minified by hand one rule a line (`widget-mic.ts`
 * says why): one for the widget's shadow root, one for the page.
 *
 * The banner reuses the comment mode's `.picker-banner` and its phone face
 * `.quick`, and the review sheet reuses the dock's `.cw-dock-scrim` /
 * `.cw-modal`, all already in the widget's own sheet. What is here is only
 * what edit mode adds. Colours are the widget's thread palette: orange
 * `#e36f1e` for waiting on the agent, green `#2da44e` for applied.
 */

export const EDIT_SHADOW_CSS = [
  // In edit mode the stack folds to the button that leaves it.
  ':host(.cfw-edit-on) .fab,:host(.cfw-edit-on) .fab-list{display:none}',
  '.picker-banner .edit-count{background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:99px;padding:3px 12px;font-size:12px;cursor:pointer;min-height:44px;display:inline-flex;align-items:center;flex:0 0 auto}',
  '.picker-banner .edit-send{background:#2e7dd7;color:#fff;border:1px solid #2e7dd7;border-radius:6px;padding:3px 12px;font-size:12px;cursor:pointer;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}',
  '.picker-banner .edit-send:disabled{opacity:.5;cursor:default}',
  '.picker-banner.quick .edit-count{background:#f6f8fa;color:#1b1f23;border-color:#d1d5da}',
  '.picker-banner .edit-note{color:#ffd8b5}',
  '.picker-banner.quick .edit-note{color:#b45309}',
  '.picker-banner [hidden]{display:none}',
  '.cw-editrow{padding:8px 0;border-bottom:1px solid #f0f3f6;display:flex;gap:10px;align-items:flex-start}',
  '.cw-editrow:last-child{border-bottom:0}',
  '.cw-editrow .grow{flex:1 1 auto;min-width:0}',
  '.cw-editrow .where{font-size:11px;color:#6e7781;margin-bottom:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}',
  '.cw-editrow .was{color:#8c959f;text-decoration:line-through;overflow-wrap:anywhere}',
  '.cw-editrow .now{color:#1b1f23;overflow-wrap:anywhere}',
  '.cw-editrow .now::before{content:"→ ";color:#6e7781}',
  '.cw-editrow .gone{color:#8c959f;font-style:italic}',
  '.cw-editrow .drop{flex:0 0 auto;min-width:44px;min-height:44px;background:none;border:0;color:#6e7781;font-size:18px;cursor:pointer}',
  '.cw-modal-foot{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid #eaeef2}',
  '.cw-modal-foot .grow{flex:1 1 auto;font-size:12px;color:#6e7781}',
].join('');

/**
 * The page's sheet. Every mark is a node in edit mode's own fixed layer, so
 * nothing here restyles an element of the page: the change bar, the wash and
 * the hover box are boxes laid over it. The outline on the element being
 * typed into is the one exception, and it is the picker's own outline.
 * The wash is translucent rather than blended: the layer's z-index makes it
 * its own stacking context, so a multiply blend would see nothing beneath it
 * and paint an opaque box over the words.
 */
export const EDIT_PAGE_CSS = [
  '.cfw-edit-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483646}',
  '.cfw-edit-bar{position:absolute;width:3px;border-radius:2px;background:#e36f1e}',
  '.cfw-edit-bar.applied{background:#2da44e}',
  '.cfw-edit-wash{position:absolute;border-radius:3px;background:rgba(245,130,30,.1)}',
  '.cfw-edit-wash.applied{background:rgba(40,160,80,.09)}',
  '.cfw-edit-hover{position:absolute;border-radius:3px;box-shadow:inset 0 0 0 1px #9dbde3}',
  '.cfw-undo{position:absolute;width:44px;height:44px;transform:translate(-22px,-22px);pointer-events:auto;cursor:pointer;border:0;background:none;padding:0;display:flex;align-items:center;justify-content:center}',
  '.cfw-undo span{width:24px;height:24px;border-radius:50%;background:#fff;border:1.5px solid #e36f1e;color:#b45309;font:13px/1 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.18)}',
  '[data-cfw-editing]{outline:2px solid #2e7dd7;outline-offset:2px;cursor:text}',
  'body.cfw-edit-mode{cursor:text}',
].join('');
