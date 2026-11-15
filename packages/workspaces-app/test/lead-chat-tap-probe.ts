/**
 * What took a tap meant for the lead chat's bar. CI has seen the bar stay out
 * after a tap on its centre, with no pane and no crash (run 43767519616), and
 * the driver could not say whether something covered the bar, the click never
 * reached it, or the page reloaded under it. Installed on the page before the
 * tap, this records each change in what sits on top at the bar's centre, the
 * the path of every click. `TAP_PROBE_READ` reports it, or says the page it was
 * installed on has been replaced.
 */

/** Installs the recorder on the current page. Evaluate after the page loads. */
export const TAP_PROBE_INSTALL = `(() => {
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const p = { hits: [], clicks: [] };
  window.__lcTapProbe = p;
  const deep = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const name = (el) => !el || !el.localName ? String(el && el.nodeName) : el.localName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  let last = '';
  const sample = () => {
    const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
    const bar = sr && sr.querySelector('.lc-bar');
    if (!bar || bar.hidden) return;
    const r = bar.getBoundingClientRect();
    const el = deep(r.left + r.width / 2, r.top + r.height / 2);
    const key = el && bar.contains(el) ? 'bar' : name(el);
    if (key !== last && p.hits.length < 40) p.hits.push({ t: at(), top: key });
    last = key;
  };
  setInterval(sample, 50);
  document.addEventListener('click', (e) => {
    if (p.clicks.length < 20) p.clicks.push({ t: at(), path: e.composedPath().slice(0, 4).map(name).join(' < ') });
  }, true);
})()`;

/** The record, or a note that the page the recorder was on has gone. */
export const TAP_PROBE_READ = `window.__lcTapProbe ? JSON.stringify(window.__lcTapProbe) : 'no probe: the page was replaced after it was installed'`;
