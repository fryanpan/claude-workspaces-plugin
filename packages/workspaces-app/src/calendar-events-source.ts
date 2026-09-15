/**
 * One read of `GET /api/calendar/events` per round, however many banners are
 * on the page.
 *
 * The board shell mounts `<meeting-banner>` TWICE — once in the Home pane and
 * once at the top of the board column — because only one pane is on screen at
 * a time and a live "Bot in call" must be reachable from either. Each instance
 * fetched for itself in `connectedCallback`, so every board open asked the
 * calendar the same question twice, ~150ms apart (measured over CDP on
 * staging: 2 of 2 on every run, at both 1180x820 and 430). Sentry's browser
 * project filed the pair as an N+1.
 *
 * The fix is a SHARED READ, not a longer-lived cache. Nothing here answers
 * from stored data: `readCalendarEvents` either starts a request or hands back
 * the one already in flight, and the moment that request settles the next call
 * goes to the network again. So the second banner is never shown a stale copy
 * — it is shown the SAME answer, from the same response, which is what both
 * instances wanted in the first place. The only state that outlives a round is
 * `settled`, and that is a fact about the deployment (no calendar feature, or
 * no Google account linked), not a cached value: the server said "stop
 * asking", and the page stops asking until it is loaded again.
 *
 * Whose `fetch` runs a round is whichever caller asked first. In the app every
 * instance passes the same global `fetch`; a test that mounts two banners must
 * give them one fetcher, because the second one's is never reached.
 */
import type { CalendarBannerEvent } from './meeting-banner-model.ts';

/** The one slice of `fetch` this module uses — narrow so tests stub it flat. */
export type CalendarFetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * What one round learned.
 *
 * `settled` and `unchanged` are deliberately different answers to "no events":
 * a settled read means there is no calendar to ask (503 no feature, 204 no
 * account, 404 an older server) and the banner should clear and stop; an
 * unchanged read is a blip, and a banner that clears on one flickers a live
 * meeting off the screen.
 */
export type CalendarRead =
  | { kind: 'events'; events: CalendarBannerEvent[] }
  | { kind: 'settled' }
  | { kind: 'unchanged' };

export const CALENDAR_EVENTS_URL = '/api/calendar/events';

let settled = false;
let inFlight: Promise<CalendarRead> | null = null;

/** Whether the server has said there is nothing to ask about. A caller checks
 *  this to skip a round entirely rather than to read a value. */
export function calendarReadSettled(): boolean {
  return settled;
}

export function readCalendarEvents(fetcher: CalendarFetcher): Promise<CalendarRead> {
  if (settled) return Promise.resolve({ kind: 'settled' });
  if (inFlight) return inFlight;
  const round = askServer(fetcher).then((read) => {
    inFlight = null;
    return read;
  });
  inFlight = round;
  return round;
}

async function askServer(fetcher: CalendarFetcher): Promise<CalendarRead> {
  try {
    const res = await fetcher(CALENDAR_EVENTS_URL);
    if (res.status === 503 || res.status === 204 || res.status === 404) {
      // All three are settled, not errors — and the body is never read: a 204
      // has none, and calling `.json()` on one lands in the catch below, which
      // would turn a settled state into a retry.
      settled = true;
      return { kind: 'settled' };
    }
    if (!res.ok) return { kind: 'unchanged' };
    const body = (await res.json()) as { events?: CalendarBannerEvent[] };
    return { kind: 'events', events: Array.isArray(body.events) ? body.events : [] };
  } catch {
    return { kind: 'unchanged' };
  }
}

export function _resetCalendarEventsForTest(): void {
  settled = false;
  inFlight = null;
}
