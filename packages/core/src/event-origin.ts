/**
 * The two cookies a person's browser carries so an analytics event it causes
 * can say which device it came from and roughly where.
 *
 * Cookies rather than a header because they ride every same-origin request
 * with no call site remembering them — a `fetch`, a `sendBeacon` from
 * `pagehide`, a form post — and the event writers on the server are two
 * choke points that never see which client code path produced the request.
 *
 * Both halves agree through this file: the page writes the value, the server
 * reads it back, and the rounding is applied on BOTH sides. The page rounds so
 * a precise fix never leaves the device; the server rounds again so a cookie
 * somebody wrote by hand cannot put a precise one in the log.
 */

/** `<lat>,<lng>`, each rounded to two decimals (about a kilometre). */
export const GEO_COOKIE = 'cw_geo';

/** `navigator.maxTouchPoints`. iPadOS Safari reports a Mac user agent, and
 *  touch points are the only thing that tells the two apart. */
export const TOUCH_COOKIE = 'cw_touch';

/** A position fix, rounded. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Two decimals of a degree: ~1.1 km of latitude, less of longitude. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The cookie value for a fix, rounded here whatever the caller passed. */
export function formatGeoCookie(lat: number, lng: number): string {
  return `${roundCoordinate(lat)},${roundCoordinate(lng)}`;
}

/**
 * Read a `cw_geo` value back. Anything that is not two finite numbers inside
 * the globe's ranges is refused, and what is accepted is rounded again.
 */
export function parseGeoCookie(value: string | null | undefined): GeoPoint | undefined {
  if (!value) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  const parts = decoded.split(',');
  if (parts.length !== 2) return undefined;
  const [lat, lng] = parts.map((p) =>
    /^-?\d{1,3}(\.\d+)?$/.test(p.trim()) ? Number(p) : Number.NaN,
  );
  if (lat === undefined || lng === undefined) return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat: roundCoordinate(lat), lng: roundCoordinate(lng) };
}
