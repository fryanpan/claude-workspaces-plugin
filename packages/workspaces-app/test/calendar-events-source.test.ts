/**
 * The shared calendar read. Everything here is about how many times the
 * server is asked, and what the answer means to a caller — the element's own
 * rendering lives in meeting-banner-element.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CALENDAR_EVENTS_URL,
  _resetCalendarEventsForTest,
  calendarReadSettled,
  readCalendarEvents,
} from '../src/calendar-events-source.ts';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () =>
      status === 204 ? Promise.reject(new Error('204 has no body')) : Promise.resolve(body),
  } as unknown as Response;
}

/** A fetcher that answers only when the test lets it, so two callers can be
 *  in flight at once without a timer deciding the outcome. */
function heldFetcher(status = 200, body: unknown = { events: [] }) {
  const urls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    urls,
    release,
    fetcher: async (url: string) => {
      urls.push(url);
      await gate;
      return response(status, body);
    },
  };
}

beforeEach(() => {
  _resetCalendarEventsForTest();
});

describe('readCalendarEvents', () => {
  it('asks once when two callers want the answer at the same time', async () => {
    const held = heldFetcher(200, { events: [{ id: 'e1' }] });
    const first = readCalendarEvents(held.fetcher);
    const second = readCalendarEvents(held.fetcher);
    held.release();
    const [a, b] = await Promise.all([first, second]);
    expect(held.urls).toEqual([CALENDAR_EVENTS_URL]);
    expect(a).toEqual({ kind: 'events', events: [{ id: 'e1' }] });
    // The same answer, not a copy of an older one: both callers read the one
    // response this round produced.
    expect(b).toEqual(a);
  });

  it('asks the server again once the round has settled — it is a shared read, not a cache', async () => {
    const urls: string[] = [];
    const fetcher = (url: string) => {
      urls.push(url);
      return Promise.resolve(response(200, { events: [] }));
    };
    await readCalendarEvents(fetcher);
    await readCalendarEvents(fetcher);
    expect(urls).toEqual([CALENDAR_EVENTS_URL, CALENDAR_EVENTS_URL]);
  });

  it.each([503, 204, 404])('settles on %i and stops asking for every caller', async (status) => {
    const urls: string[] = [];
    const fetcher = (url: string) => {
      urls.push(url);
      return Promise.resolve(response(status, {}));
    };
    expect(await readCalendarEvents(fetcher)).toEqual({ kind: 'settled' });
    expect(calendarReadSettled()).toBe(true);
    expect(await readCalendarEvents(fetcher)).toEqual({ kind: 'settled' });
    expect(urls).toEqual([CALENDAR_EVENTS_URL]);
  });

  it('reports a transient failure as unchanged, and keeps asking', async () => {
    const urls: string[] = [];
    const fetcher = (url: string) => {
      urls.push(url);
      return Promise.resolve(response(500, {}));
    };
    expect(await readCalendarEvents(fetcher)).toEqual({ kind: 'unchanged' });
    expect(calendarReadSettled()).toBe(false);
    await readCalendarEvents(fetcher);
    expect(urls.length).toBe(2);
  });

  it('reports a thrown fetch as unchanged rather than settling', async () => {
    const fetcher = () => Promise.reject(new TypeError('offline'));
    expect(await readCalendarEvents(fetcher)).toEqual({ kind: 'unchanged' });
    expect(calendarReadSettled()).toBe(false);
  });

  it('treats a body without an events array as no events', async () => {
    const fetcher = () => Promise.resolve(response(200, { events: 'nope' }));
    expect(await readCalendarEvents(fetcher)).toEqual({ kind: 'events', events: [] });
  });
});
