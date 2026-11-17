/**
 * A stand-in for Google's Maps JavaScript API, served in place of
 * `https://maps.googleapis.com/maps/api/js` by the Google basemap's browser
 * driver, so no request reaches Google.
 *
 * It does the part GoogleMutant reads: a `google.maps.Map` that, wherever it
 * is centred, adds roadmap tile images to its container under the address
 * shape Google's own tiles use (`/maps/vt?pb=!1m5!1m4!1i<z>!2i<x>!3i<y>…`),
 * an `idle` event, and the two corner nodes Google puts its logo and terms
 * link in. It then calls the page's `callback`, as Google's loader does, and
 * for `REFUSED_KEY` then calls `gm_authFailure`, as Google does for a key it
 * refuses.
 * The tile images are answered by the driver with a plain PNG.
 *
 * audit: no-text — a script for the page, not a read of any source.
 */
/** The key the keyed server holds: not a real one. */
export const FAKE_KEY = 'fake-maps-key-riverbend-0000';

/** A key the stand-in refuses, as Google does a key it will not serve:
 *  it calls the page's `gm_authFailure` once the API is up. */
export const REFUSED_KEY = 'fake-maps-key-refused-0000';

/** A key whose script request the driver fails, as if Google's script never
 *  arrived. */
export const UNLOADED_KEY = 'fake-maps-key-unloaded-0000';

export const GOOGLE_CREDIT = 'Map data stand-in for Google';

export const FAKE_GOOGLE_MAPS_JS: string = `(() => {
  const params = new URL(document.currentScript.src).searchParams;
  const tile = (lat, lng, z) => {
    const n = 2 ** z;
    const r = (lat * Math.PI) / 180;
    return {
      x: Math.floor(((lng + 180) / 360) * n),
      y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
    };
  };
  class LatLng {
    constructor(lat, lng) { this.a = lat; this.b = lng; }
    lat() { return this.a; }
    lng() { return this.b; }
  }
  class GMap {
    constructor(div, opts) {
      this.div = div;
      this.zoom = opts.zoom;
      this.center = opts.center;
      this.painted = new Set();
      const corners = new Map();
      const corner = (p, words) => {
        const n = document.createElement('div');
        n.className = 'fake-gm-corner';
        n.textContent = words;
        corners.set(p, n);
      };
      corner(10, 'Google');
      corner(12, ${JSON.stringify(GOOGLE_CREDIT)});
      this.__gm = { layoutManager: { positions: { get: (p) => corners.get(p) ?? corners.get(10) } } };
      this.paint();
    }
    setCenter(c) { this.center = { lat: c.lat(), lng: c.lng() }; this.paint(); }
    setZoom(z) { this.zoom = z; this.paint(); }
    getZoom() { return this.zoom; }
    paint() {
      const z = Math.max(0, Math.round(this.zoom));
      const at = tile(this.center.lat, this.center.lng, z);
      const n = 2 ** z;
      for (let dx = -4; dx <= 4; dx++) {
        for (let dy = -4; dy <= 4; dy++) {
          const x = at.x + dx;
          const y = at.y + dy;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const k = z + '/' + x + '/' + y;
          if (this.painted.has(k)) continue;
          this.painted.add(k);
          const img = document.createElement('img');
          img.src = 'https://maps.googleapis.com/maps/vt?pb=!1m5!1m4!1i' + z + '!2i' + x + '!3i' + y + '!4i256!2m3!1e0!2sm!3i0';
          this.div.appendChild(img);
        }
      }
    }
  }
  window.google = {
    maps: {
      Map: GMap,
      LatLng,
      ControlPosition: { BOTTOM_LEFT: 10, BOTTOM_RIGHT: 12 },
      event: {
        addListenerOnce: (_obj, _name, fn) => { setTimeout(fn, 0); return { remove() {} }; },
        clearListeners: () => {},
      },
      importLibrary: async () => ({}),
    },
  };
  window[params.get('callback')]();
  if (params.get('key') === ${JSON.stringify(REFUSED_KEY)}) setTimeout(() => window.gm_authFailure?.(), 0);
})();`;
