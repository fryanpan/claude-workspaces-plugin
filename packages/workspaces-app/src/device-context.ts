/**
 * What this page tells the server about its device, for the analytics rows a
 * person's actions write (server: `event-origin.ts`).
 *
 * Two cookies, both read back by the server on every request:
 *  - `cw_touch` — `navigator.maxTouchPoints`, on every page. iPadOS Safari
 *    sends a Mac user agent, and this is what tells the two apart.
 *  - `cw_geo` — where the device is, rounded to two decimals (~1 km), and only
 *    after the person allowed it.
 *
 * The location prompt appears AT MOST ONCE per device, and only on a board
 * load. The answer is remembered in localStorage and the Permissions API is
 * asked first, because each covers a hole in the other:
 *  - the Permissions API says `prompt` both before anyone was asked and after
 *    a person DISMISSED the prompt (and after Safari's one-day "allow" ran
 *    out), so on its own it would ask again — the stored answer is what stops
 *    that;
 *  - the stored answer cannot see a person granting or revoking in the
 *    browser's own settings, which the Permissions API can.
 *
 * So: `granted` refreshes the fix silently on any page; `denied` clears it;
 * `prompt` (or no Permissions API) asks only when nothing is stored and the
 * caller is the board. The answer is written BEFORE the prompt opens, so a
 * reload while it is up does not ask a second time.
 */
import { GEO_COOKIE, TOUCH_COOKIE, formatGeoCookie } from '@claude-workspaces/core';
import type { BootStorage } from './boot-env.ts';

/** Where the answer to the one prompt is kept. */
export const GEO_ANSWER_KEY = 'cw.geo.answer';

/** A year, for the touch hint; a day for the fix, so a stale one ages out. */
const TOUCH_MAX_AGE_S = 365 * 24 * 60 * 60;
const GEO_MAX_AGE_S = 24 * 60 * 60;

export interface DeviceContextEnv {
  navigator: {
    maxTouchPoints?: number;
    geolocation?: Pick<Geolocation, 'getCurrentPosition'>;
    permissions?: { query(d: { name: 'geolocation' }): Promise<{ state: string }> };
  };
  document: { cookie: string };
  storage: BootStorage;
  /** `https:` — the cookies are marked Secure there. */
  secure: boolean;
}

/** What happened, for the tests and nothing else. */
export type DeviceContextOutcome = 'asked' | 'refreshed' | 'cleared' | 'unchanged';

function setCookie(env: DeviceContextEnv, name: string, value: string, maxAge: number): void {
  const secure = env.secure ? '; Secure' : '';
  env.document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Strict${secure}`;
}

function remember(env: DeviceContextEnv, answer: 'asked' | 'granted' | 'denied'): void {
  try {
    env.storage.setItem(GEO_ANSWER_KEY, answer);
  } catch {
    // Blocked storage (Safari private mode) — the Permissions API still
    // answers `denied` / `granted` next time; only a dismissed prompt can
    // come back, and only where storage is refused outright.
  }
}

function stored(env: DeviceContextEnv): string | null {
  try {
    return env.storage.getItem(GEO_ANSWER_KEY);
  } catch {
    return null;
  }
}

async function permissionState(env: DeviceContextEnv): Promise<string> {
  try {
    return (await env.navigator.permissions?.query({ name: 'geolocation' }))?.state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** One fix, written to the cookie. Resolves once the browser answers. */
function locate(
  env: DeviceContextEnv,
  geo: Pick<Geolocation, 'getCurrentPosition'>,
): Promise<boolean> {
  return new Promise((resolve) => {
    geo.getCurrentPosition(
      (pos) => {
        setCookie(
          env,
          GEO_COOKIE,
          formatGeoCookie(pos.coords.latitude, pos.coords.longitude),
          GEO_MAX_AGE_S,
        );
        resolve(true);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          remember(env, 'denied');
          setCookie(env, GEO_COOKIE, '', 0);
        }
        resolve(false);
      },
      { enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: 20_000 },
    );
  });
}

/**
 * Write the touch hint, then refresh, clear or (on the board, once) ask for
 * the location. Never throws: a page's boot must not fail on analytics.
 */
export async function syncDeviceContext(
  env: DeviceContextEnv,
  opts: { mayAsk: boolean },
): Promise<DeviceContextOutcome> {
  try {
    setCookie(env, TOUCH_COOKIE, String(env.navigator.maxTouchPoints ?? 0), TOUCH_MAX_AGE_S);
    const geo = env.navigator.geolocation;
    if (!geo) return 'unchanged';
    const state = await permissionState(env);
    if (state === 'denied') {
      remember(env, 'denied');
      setCookie(env, GEO_COOKIE, '', 0);
      return 'cleared';
    }
    if (state === 'granted') {
      remember(env, 'granted');
      await locate(env, geo);
      return 'refreshed';
    }
    if (stored(env) !== null || !opts.mayAsk) return 'unchanged';
    remember(env, 'asked');
    if (await locate(env, geo)) remember(env, 'granted');
    return 'asked';
  } catch {
    return 'unchanged';
  }
}

/** The real browser, read lazily so a page without these globals still boots. */
export function browserDeviceEnv(storage: BootStorage): DeviceContextEnv {
  return { navigator, document, storage, secure: location.protocol === 'https:' };
}
