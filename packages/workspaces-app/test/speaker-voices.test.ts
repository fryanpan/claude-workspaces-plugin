import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDocSpeakersCache,
  loadDocSpeakers,
  loadDocTranscript,
  loadDocVoices,
  postSpeakerName,
} from '../src/speaker-voices.ts';

/** The board the page is standing on — every resource route is under it. */
const WS = 'w-1';

beforeEach(() => {
  history.replaceState(null, '', `/workspaces/${WS}/docs/d-1`);
});

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;

describe('loadDocVoices', () => {
  it('asks the latest meeting for its cast, and names them from the record', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/meetings')) {
        return ok({
          meetings: [
            { meetingId: 'm-old', startedAt: 100 },
            { meetingId: 'm-new', startedAt: 900 },
          ],
        });
      }
      return ok({
        speakers: { A: 'Devi' },
        transcript: [
          { text: 'Move the gate.', speaker: 'A' },
          { text: 'Not before Friday.', speaker: 'B' },
        ],
      });
    });
    const voices = await loadDocVoices('huddle', fetchImpl as unknown as typeof fetch);
    expect(voices).toEqual([
      { label: 'A', name: 'Devi', given: 'Devi', lastSaid: 'Move the gate.' },
      { label: 'B', name: 'Speaker B', lastSaid: 'Not before Friday.' },
    ]);
    // The LATEST meeting, not the first the index happened to list.
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('m-new');
  });

  it('offers nothing for a doc that has never had a meeting', async () => {
    const fetchImpl = vi.fn(async () => ok({ meetings: [] }));
    expect(await loadDocVoices('plain', fetchImpl as unknown as typeof fetch)).toEqual([]);
    // One request, not two: there is no meeting to ask about.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects rather than reporting an empty cast when the request fails', async () => {
    // An empty menu and a broken menu look identical to a reader, and only
    // one of them means "this capture had one voice".
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    await expect(loadDocVoices('huddle', fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'meetings 500',
    );
  });

  it('escapes a doc id that would otherwise change the path', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return ok({ meetings: [] });
    });
    await loadDocVoices('a/b', fetchImpl as unknown as typeof fetch);
    expect(seen[0]).toBe(`/workspaces/${WS}/docs/a%2Fb/meetings`);
  });
});

describe('loadDocSpeakers', () => {
  it('says WHICH meeting the cast belongs to — a later rename is addressed to it', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/meetings')) {
        return ok({ meetings: [{ meetingId: 'm-1', startedAt: 100 }] });
      }
      return ok({ transcript: [{ text: 'Hi.', speaker: 'A' }] });
    });
    expect(await loadDocSpeakers('huddle', fetchImpl as unknown as typeof fetch)).toEqual({
      meetingId: 'm-1',
      voices: [{ label: 'A', name: 'Speaker A', lastSaid: 'Hi.' }],
    });
  });

  it('answers null, not an empty cast, for a doc that has never held a meeting', async () => {
    const fetchImpl = vi.fn(async () => ok({ meetings: [] }));
    expect(await loadDocSpeakers('plain', fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});

describe('loadDocTranscript', () => {
  it('renders the latest meeting’s turns in the raw record’s own grammar', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/meetings')) {
        return ok({
          meetings: [
            { meetingId: 'm-old', startedAt: 100 },
            { meetingId: 'm-new', startedAt: 900 },
          ],
        });
      }
      return ok({
        speakers: { p7: 'Rowan Pike' },
        transcript: [
          {
            turn: 0,
            text: 'So the\n  Riverbend sync.',
            speaker: 'p7',
            ts: Date.UTC(2026, 8, 9, 9, 12, 4),
          },
          { turn: 1, text: 'Right.', speaker: 'p8', ts: Date.UTC(2026, 8, 9, 9, 12, 9) },
          // No speaker at all: a solo capture's turns carry none.
          { turn: 2, text: 'Ending there.', ts: Date.UTC(2026, 8, 9, 9, 12, 20) },
        ],
      });
    });
    expect(await loadDocTranscript('huddle', fetchImpl as unknown as typeof fetch)).toEqual({
      meetingId: 'm-new',
      lines: [
        '[09:12:04Z] Rowan Pike: So the Riverbend sync.',
        '[09:12:09Z] Speaker p8: Right.',
        '[09:12:20Z] Speaker 1: Ending there.',
      ],
    });
    // The LATEST meeting, which after a bot call is the one that just ended.
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('m-new');
  });

  it('answers null for a doc that has never held a meeting', async () => {
    const fetchImpl = vi.fn(async () => ok({ meetings: [] }));
    expect(await loadDocTranscript('plain', fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('postSpeakerName', () => {
  it('posts the name to the meeting it belongs to, and reports the server took it', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init ?? {}]);
      return { ok: true, status: 200 } as unknown as Response;
    };
    const took = await postSpeakerName(
      { docId: 'a/b', meetingId: 'm 1', speaker: 'B', name: 'Priya' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(took).toBe(true);
    expect(calls[0]?.[0]).toBe(`/workspaces/${WS}/docs/a%2Fb/meetings/m%201/speakers`);
    expect(calls[0]?.[1].method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({ speaker: 'B', name: 'Priya' });
  });

  it('reports a refusal as false — the caller must not show a name the record refused', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 409 }) as unknown as Response);
    expect(
      await postSpeakerName(
        { docId: 'doc', meetingId: 'm-1', speaker: 'A', name: 'Sam' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).toBe(false);
  });
});

describe('createDocSpeakersCache — the roster the menu opens on', () => {
  const record = (speakers: Record<string, string>) => [
    ok({ meetings: [{ meetingId: 'm-1', startedAt: 5, speakers }] }),
    ok({ speakers, transcript: [{ text: 'Move the gate.', speaker: 'room:A' }] }),
  ];

  it('is empty until asked, and holds the answer afterwards', async () => {
    const pages = record({ 'room:A': 'Rowan' });
    const fetchImpl = vi.fn(async () => pages.shift() as Response);
    const cache = createDocSpeakersCache('d-1', fetchImpl as unknown as typeof fetch);
    expect(cache.peek()).toBeNull();
    await cache.load();
    expect(cache.peek()?.voices.map((v) => v.name)).toEqual(['Rowan']);
  });

  it('serves two overlapping loads from one pair of requests', async () => {
    const pages = record({ 'room:A': 'Rowan' });
    const fetchImpl = vi.fn(async () => pages.shift() as Response);
    const cache = createDocSpeakersCache('d-1', fetchImpl as unknown as typeof fetch);
    // What the mount and a tap in the same moment do: the second must ride
    // the first rather than start a second pair of round trips.
    const [a, b] = await Promise.all([cache.load(), cache.load()]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('holds the last good answer when a later load throws', async () => {
    const pages = record({ 'room:A': 'Rowan' });
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error('offline');
      return pages.shift() as Response;
    });
    const cache = createDocSpeakersCache('d-1', fetchImpl as unknown as typeof fetch);
    await cache.load();
    fail = true;
    await expect(cache.load()).rejects.toThrow('offline');
    expect(cache.peek()?.voices.map((v) => v.name)).toEqual(['Rowan']);
  });

  /**
   * The cache is keyed by the meeting it came from, because a doc holds more
   * than one and the roster of the last one is a list of the WRONG people to
   * offer. Codex caught it on the menu: a doc that starts a second meeting
   * kept painting the first one's voices as reassignment targets until the
   * refresh landed, so a tap in that window moved a note onto a voice that
   * belongs to a meeting that is over.
   */
  const meeting = (id: string, speakers: Record<string, string>) => [
    ok({ meetings: [{ meetingId: id, startedAt: 5, speakers }] }),
    ok({ speakers, transcript: [{ text: 'Move the gate.', speaker: 'room:A' }] }),
  ];

  it('serves nothing once a meeting has started that it holds no roster for', async () => {
    const pages = meeting('m-1', { 'room:A': 'Rowan' });
    const fetchImpl = vi.fn(async () => pages.shift() as Response);
    const cache = createDocSpeakersCache('d-1', fetchImpl as unknown as typeof fetch);
    await cache.load();
    expect(cache.peek()).not.toBeNull();
    // A capture has begun; the server has not said which meeting it is yet.
    cache.meetingChanged(null);
    expect(cache.peek()).toBeNull();
  });

  it('serves the new meeting once its own load lands', async () => {
    const pages = [...meeting('m-1', { 'room:A': 'Rowan' })];
    const fetchImpl = vi.fn(async () => pages.shift() as Response);
    const cache = createDocSpeakersCache('d-1', fetchImpl as unknown as typeof fetch);
    await cache.load();
    cache.meetingChanged('m-2');
    expect(cache.peek()).toBeNull();
    pages.push(...meeting('m-2', { 'room:A': 'Priya' }));
    await cache.load();
    expect(cache.peek()?.voices.map((v) => v.name)).toEqual(['Priya']);
  });

  it('refuses an answer for the meeting that was current when it was asked', async () => {
    const pages = [...meeting('m-1', { 'room:A': 'Rowan' })];
    const fetchImpl = vi.fn(async () => pages.shift() as Response);
    const cache = createDocSpeakersCache('d-1', fetchImpl as unknown as typeof fetch);
    // The load is in flight when the boundary passes: its answer is about the
    // meeting before it, so it must not become what the next tap paints.
    const inFlight = cache.load();
    cache.meetingChanged('m-2');
    await inFlight;
    expect(cache.peek()).toBeNull();
  });

  it('keeps a roster the boundary named as the current meeting', async () => {
    const pages = meeting('m-1', { 'room:A': 'Rowan' });
    const fetchImpl = vi.fn(async () => pages.shift() as Response);
    const cache = createDocSpeakersCache('d-1', fetchImpl as unknown as typeof fetch);
    await cache.load();
    // The meeting that just stopped IS the doc's latest: nothing to discard.
    cache.meetingChanged('m-1');
    expect(cache.peek()?.voices.map((v) => v.name)).toEqual(['Rowan']);
  });
});
