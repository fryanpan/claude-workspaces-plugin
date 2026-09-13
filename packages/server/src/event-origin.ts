/**
 * Which device, and roughly where, a person's browser was when it caused an
 * analytics event.
 *
 * The Weekly Review agent reads two logs — `activity.jsonl` and each board's
 * `events.jsonl` — and each has exactly one writer (`appendActivity`,
 * `TaskEventBus.appendAudit`). Neither writer sees a request: they sit under
 * some twenty verbs that do. So the request's origin travels to them in an
 * `AsyncLocalStorage` context opened around the whole request, and each
 * writer stamps what it finds there.
 *
 * Two rules keep a row from claiming a browser it never had:
 *
 *  - **Only a browser request opens a context with anything in it.** An MCP
 *    tool call, a curl, the server's own timers: no `device`, no `location`.
 *  - **The context closes when the request is answered.** A timer or interval
 *    started inside a request inherits its async context for life — measured
 *    under Bun, where a `setTimeout` scheduled in a handler still saw that
 *    request's store after the response went out. The store is one object
 *    shared by reference, so flipping `open` off after the handler returns
 *    reaches every continuation that inherited it, and a debounce firing a
 *    minute later writes an unstamped row rather than a stale one.
 *
 * `location` never leaves this server. It is stamped onto the log line only
 * (not onto the SSE payload), redacted from a share visitor's Activity tab by
 * `redactBoardEventForVisitor`, and never logged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { GEO_COOKIE, type GeoPoint, TOUCH_COOKIE, parseGeoCookie } from '@claude-workspaces/core';

/** The four kinds Weekly Review buckets by. A Mac is `desktop`. */
export type DeviceKind = 'ipad' | 'phone' | 'desktop' | 'other';

export interface EventDevice {
  kind: DeviceKind;
  /** `Safari`, `Chrome`, `Firefox`, `Edge`, `Opera`, or `other`. */
  browser: string;
}

/** What a stamped row gains. Both fields absent for anything not a browser. */
export interface EventOrigin {
  device?: EventDevice;
  location?: GeoPoint;
}

interface OriginContext {
  origin: EventOrigin;
  open: boolean;
}

const store = new AsyncLocalStorage<OriginContext>();

/** Pull one cookie out of a Cookie header. */
function cookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq >= 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Classify a User-Agent. `touchPoints` is the page's `navigator.maxTouchPoints`
 * from the `cw_touch` cookie, or null when the page never wrote it — the only
 * way to tell iPadOS Safari (which sends a Macintosh UA) from a Mac.
 */
export function deviceFromUserAgent(ua: string, touchPoints: number | null): EventDevice {
  return { kind: deviceKind(ua, touchPoints), browser: browserName(ua) };
}

function deviceKind(ua: string, touchPoints: number | null): DeviceKind {
  if (/\biPad\b/.test(ua)) return 'ipad';
  if (/\b(iPhone|iPod)\b/.test(ua) || /\bAndroid\b.*\bMobile\b/.test(ua)) return 'phone';
  if (/\bMacintosh\b/.test(ua)) return touchPoints !== null && touchPoints > 1 ? 'ipad' : 'desktop';
  if (/\bAndroid\b/.test(ua)) return 'other';
  if (/\b(Windows NT|X11|Linux|CrOS)\b/.test(ua)) return 'desktop';
  return 'other';
}

/** Order matters: Edge and Opera also say Chrome, and Chrome also says Safari. */
function browserName(ua: string): string {
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/\b(OPR|OPiOS)\//.test(ua)) return 'Opera';
  if (/\b(Firefox|FxiOS)\//.test(ua)) return 'Firefox';
  if (/\b(Chrome|CriOS|Chromium)\//.test(ua)) return 'Chrome';
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua)) return 'Safari';
  return 'other';
}

/**
 * The origin a request's events carry. `isBrowser` is the caller's verdict
 * (`isBrowserRequest`, which lives in the HTTP layer this module sits below);
 * anything that is not a browser gets an empty origin.
 */
export function originOfHeaders(headers: Headers, isBrowser: boolean): EventOrigin {
  if (!isBrowser) return {};
  const cookies = headers.get('cookie');
  const touchRaw = cookie(cookies, TOUCH_COOKIE);
  const touch = touchRaw !== undefined && /^\d{1,3}$/.test(touchRaw) ? Number(touchRaw) : null;
  const origin: EventOrigin = {
    device: deviceFromUserAgent(headers.get('user-agent') ?? '', touch),
  };
  const location = parseGeoCookie(cookie(cookies, GEO_COOKIE));
  if (location) origin.location = location;
  return origin;
}

/** Run one request's handling with its origin in scope, closing it after. */
export async function withEventOrigin<T>(origin: EventOrigin, fn: () => Promise<T>): Promise<T> {
  const ctx: OriginContext = { origin, open: true };
  try {
    return await store.run(ctx, fn);
  } finally {
    ctx.open = false;
  }
}

/** The in-flight request's origin, or an empty one. */
export function currentEventOrigin(): EventOrigin {
  const ctx = store.getStore();
  return ctx?.open ? ctx.origin : {};
}

/**
 * `row` plus `device` / `location` from the in-flight request, when it has
 * them. A row that already carries either keeps its own.
 */
export function stampEventOrigin<T extends object>(row: T): T & EventOrigin {
  const { device, location } = currentEventOrigin();
  const has = row as EventOrigin;
  return {
    ...row,
    ...(device && has.device === undefined ? { device } : {}),
    ...(location && has.location === undefined ? { location } : {}),
  };
}
