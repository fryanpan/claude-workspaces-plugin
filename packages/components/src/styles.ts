/**
 * The map component's own styles, put on the page by the component the first
 * time it draws there: Leaflet's stylesheet and the few rules for the title,
 * legend, layer switches and notices around the map. A host links nothing.
 *
 * Every rule names a `cw-map` class or a Leaflet one, so nothing here
 * reaches the host's own elements. A host restyles the words around the map
 * with `--cw-map-muted` (the colour of the subtitle, note and notices) or by
 * writing its own rules for the classes.
 */
import { LEAFLET_CSS } from './leaflet-css.ts';

const MAP_CSS = [
  '.cw-map{margin:0}',
  '.cw-map-title{font-weight:600;margin:0 0 .25em}',
  '.cw-map-subtitle,.cw-map-note,.cw-map-notice{margin:.25em 0;font-size:.875em;color:var(--cw-map-muted,#4b5563)}',
  '.cw-map-slot{position:relative;width:100%;border-radius:6px;overflow:hidden;background:#e5e7eb}',
  '.cw-map-legend{list-style:none;display:flex;flex-wrap:wrap;gap:.25em 1em;margin:.5em 0 0;padding:0;font-size:.875em}',
  '.cw-map-legend li{display:flex;align-items:center;gap:.4em}',
  '.cw-map-swatch{display:inline-block;width:.75em;height:.75em;border-radius:50%}',
  '.cw-map-swatch.is-ring{box-sizing:border-box;border:2px solid;background:none}',
  '.cw-map-layers{list-style:none;display:flex;flex-wrap:wrap;gap:.25em 1em;margin:.5em 0 0;padding:0;font-size:.875em}',
  '.cw-map-layers label{display:inline-flex;align-items:center;gap:.4em;cursor:pointer}',
  '.cw-map-layers input{margin:0}',
  '.cw-map-swatch.is-line{height:.2em;width:1.1em;border-radius:1px}',
  '.cw-map-swatch.is-polygon{border-radius:2px;opacity:.7}',
  '.cw-map-swatch.is-heatmap{opacity:.8}',
  '.cw-map-layer-why{margin-left:.4em;color:var(--cw-map-muted,#4b5563)}',
  '.cw-map-popup{white-space:pre-line}',
  // The markers' SVG spans the view; only its paths take taps, so a tap
  // between markers reaches the canvas of points and layers beneath.
  '.cw-map-slot .leaflet-pane>svg{pointer-events:none}',
  '.cw-map-error{padding:.75em;border:1px solid #fca5a5;border-radius:6px;background:#fef2f2;color:#991b1b}',
].join('');

const MARK = 'data-cw-components-map';

/** Put the styles in the document or shadow root `el` sits in, once. */
export function ensureStyles(el: HTMLElement): void {
  const root = el.getRootNode();
  const into =
    root instanceof ShadowRoot
      ? root
      : root instanceof Document
        ? root.head
        : el.ownerDocument.head;
  if (!into || into.querySelector(`style[${MARK}]`)) return;
  const style = el.ownerDocument.createElement('style');
  style.setAttribute(MARK, '');
  style.textContent = LEAFLET_CSS + MAP_CSS;
  into.prepend(style);
}
