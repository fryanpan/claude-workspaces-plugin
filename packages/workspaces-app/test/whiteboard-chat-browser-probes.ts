/** Page expressions the whiteboard chat driver evaluates. */
const LAYER = `document.querySelector('[data-lead-chat="layer"]')?.shadowRoot`;
const AGENT = `document.querySelector('[data-lead-chat="button"]')`;

export const READY = `document.body.dataset.whiteboardReady === '1'`;

export const LISTENING = `(() => {
  const b = ${AGENT}?.shadowRoot?.querySelector('button');
  return !!b && b.dataset.listening === 'true';
})()`;

/** The page's bar: the doc's own `#topbar`, and what a reader finds in it. */
export const PAGE = `(() => {
  const bar = document.getElementById('topbar');
  const r = bar && bar.getBoundingClientRect();
  const back = bar && bar.querySelector('.doc-crumb .back-link');
  const title = bar && bar.querySelector('.doc-crumb .doc-path');
  return {
    bar: r ? {
      height: r.height,
      top: r.top,
      width: r.width,
      background: getComputedStyle(bar).backgroundColor,
      back: back ? new URL(back.href).pathname : null,
      title: title ? title.textContent.trim() : null,
      people: !!bar.querySelector('#doc-people'),
    } : null,
    nav: (() => {
      const n = document.querySelector('.board-nav');
      if (!n) return null;
      const b = n.getBoundingClientRect();
      return {
        rect: [b.left, b.top, b.width, b.height],
        links: [...n.querySelectorAll('a')].map((a) => [new URL(a.href).pathname, a.textContent.trim()]),
      };
    })(),
  };
})()`;

export const CHAT = `(() => {
  const host = ${AGENT};
  const btn = host && !host.hidden && host.shadowRoot && host.shadowRoot.querySelector('button');
  const r = btn ? btn.getBoundingClientRect() : null;
  const sr = ${LAYER};
  const pane = sr && sr.querySelector('.lc-pane');
  const bar = sr && sr.querySelector('.lc-bar');
  const shown = !!pane && !pane.hidden;
  return {
    button: r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null,
    label: btn ? btn.getAttribute('aria-label') : null,
    placement: host ? (host.dataset.placement ?? host.getAttribute('data-placement')) : null,
    pane: shown,
    paneKind: !shown ? null : pane.classList.contains('lc-sheet') ? 'lc-sheet' : pane.classList.contains('lc-dock') ? 'lc-dock' : '',
    bar: !!bar && !bar.hidden,
    barAt: !!bar && !bar.hidden ? (() => { const b = bar.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })() : null,
    listening: !!btn && btn.dataset.listening === 'true',
    messageIds: sr ? [...sr.querySelectorAll('[data-message-id]')].map((e) => e.dataset.messageId) : [],
    voiceBubbles: sr ? sr.querySelectorAll('.lc-voice').length : 0,
  };
})()`;

const centreOf = (selector: string): string => `(() => {
  const sr = ${LAYER};
  const pane = sr && sr.querySelector('.lc-pane');
  if (!pane || pane.hidden || pane.getAnimations().length > 0) return null;
  const all = sr.querySelectorAll(${JSON.stringify(selector)});
  const el = all[all.length - 1];
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width === 0) return null;
  return { x: r.left + Math.min(r.width / 2, 12), y: r.top + r.height / 2, href: el.href ?? null, target: el.getAttribute('target') };
})()`;

/** How many spoken replies the chat holds; it keeps every earlier one. */
export const VOICE_BUBBLES = `(() => {
  const sr = ${LAYER};
  return sr ? sr.querySelectorAll('.lc-voice .lc-voice-btn').length : 0;
})()`;

/** The newest voice bubble's Show words. */
export const VOICE_WORDS = centreOf('.lc-voice .lc-voice-btn');
/** The newest whiteboard link in the chat. */
export const LINK = centreOf('.lc-voice-text a[href*="/whiteboards/"]');

/** How much of the middle of the canvas holds ink: Excalidraw's drawn scene,
 *  read off the canvas itself rather than off the elements it was handed. */
export const INK = `(() => {
  const c = document.querySelector('.excalidraw canvas.static') || document.querySelector('.excalidraw canvas');
  if (!c) return 0;
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 16) {
    if (data[i] > 0 && (data[i - 3] < 200 || data[i - 2] < 200 || data[i - 1] < 200)) n++;
  }
  return n;
})()`;

/** The tool Excalidraw has selected. */
export const TOOL = `(() => {
  const on = document.querySelector('.excalidraw input[data-testid^="toolbar-"]:checked');
  return on ? on.dataset.testid.replace('toolbar-', '') : null;
})()`;

export const chipTitle = `(() => {
  const chip = document.querySelector('.board-people .board-presence-agent');
  return chip ? chip.getAttribute('title') : null;
})()`;

export const CANVAS = `(() => {
  const stage = document.getElementById('wb-stage');
  const s = stage.getBoundingClientRect();
  const c = document.querySelector('.excalidraw canvas.interactive') || document.querySelector('.excalidraw canvas');
  const cw = c ? c.getBoundingClientRect().width : 0;
  const layer = document.querySelector('[data-lead-chat="layer"]');
  const pane = layer && layer.shadowRoot && layer.shadowRoot.querySelector('.lc-pane');
  const dock = pane && !pane.hidden && pane.classList.contains('lc-dock') ? pane.getBoundingClientRect() : null;
  const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const host = ${AGENT};
  const btn = host && !host.hidden && host.shadowRoot && host.shadowRoot.querySelector('button');
  const bar = layer && layer.shadowRoot && layer.shadowRoot.querySelector('.lc-bar');
  const controls = [...document.querySelectorAll('.excalidraw button, .excalidraw label, .excalidraw .App-toolbar, .excalidraw .zoom-actions')];
  const landsOn = (mine) => {
    if (!mine || mine.hidden) return null;
    const m = mine.getBoundingClientRect();
    if (m.width === 0) return null;
    const under = controls.find((el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && st.visibility !== 'hidden' && st.opacity !== '0' && hit(m, r); });
    return under ? String(under.getAttribute('aria-label') || under.className || under.tagName) : null;
  };
  const mid = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
  return {
    stage: { left: s.left, right: s.right, width: s.width, height: s.height },
    canvasWidth: cw,
    canvasFits: Math.abs(cw - s.width) <= 1 && (!dock || s.right <= dock.left + 1),
    buttonOnControl: landsOn(btn),
    barOnControl: landsOn(bar),
    phoneLayout: !!document.querySelector('.excalidraw--mobile'),
    centreCovered: !mid || !mid.closest('.excalidraw'),
    scroll: [window.scrollX, window.scrollY],
  };
})()`;
