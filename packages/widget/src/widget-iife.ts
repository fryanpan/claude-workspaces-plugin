/**
 * The entry of `widget.iife.js` — the script tag every embed loads.
 *
 * It imports `widget.ts` for its side effects and exports nothing, because an
 * IIFE has nowhere to put exports: the build names no global for the bundle,
 * and the widget reaches the page through the two things `widget.ts` does on
 * load (`customElements.define` and `window.FeedbackWidget`). Bundled from
 * `widget.ts` directly, Bun still built the module's export object and the
 * CommonJS interop helpers that go with it, and the page paid ~290 bytes gzip
 * for code nothing could call. `widget.esm.js` keeps `widget.ts` as its entry,
 * since an ES module is imported for exactly those exports.
 */
import './widget.ts';
