/**
 * The same person takes their own meeting back from a socket that went quiet.
 *
 * A phone put in the background can leave its audio socket open for minutes
 * with nothing on it. Every Record press from the page in that time opened a
 * new socket and was refused as `already_recording`, because the old one still
 * held the doc. Now a press, or a resume, from the person the old socket
 * proved closes that socket and resumes the same meeting. Anyone else is
 * refused exactly as before, and so is a socket that proved nobody.
 *
 * The person is `data.author`, which the upgrade stamps from a proven
 * identity. The start frame's `participant` is a claim and decides nothing,
 * which the last case checks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { samePerson } from '../src/meeting-takeover.ts';
import { MeetingStore, listMeetings, meetingTranscriptPath } from '../src/meetings.ts';
import { createUpgradeStream } from '../src/routes/upgrade-stream.ts';
import type { UpgradeData } from '../src/socket-handlers.ts';
import type {
  TranscriptionEngine,
  TranscriptionOpenOpts,
  TranscriptionSession,
} from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

type Sent = Record<string, unknown>;

const ALICE: User = { id: 'u-alice', name: 'Alice', kind: 'known', color: '#336699' };
const BOB: User = { id: 'u-bob', name: 'Bob', kind: 'known', color: '#993366' };

interface Sock {
  ws: MeetingClient;
  sent: Sent[];
  closed: Array<number | undefined>;
}

function engine(): { engine: TranscriptionEngine; sessions: TranscriptionOpenOpts[] } {
  const sessions: TranscriptionOpenOpts[] = [];
  return {
    sessions,
    engine: {
      name: 'scripted',
      open: (opts): Promise<TranscriptionSession> => {
        sessions.push(opts);
        return Promise.resolve({ send: () => {}, close: () => Promise.resolve() });
      },
    },
  };
}

function socket(relay: MeetingRelay, docId: string, author?: User): Sock {
  const sent: Sent[] = [];
  const closed: Array<number | undefined> = [];
  const ws: MeetingClient = {
    data: { docId, ...(author ? { author } : {}) },
    send: (payload) => sent.push(JSON.parse(payload) as Sent),
    close: (code) => {
      closed.push(code);
    },
  };
  relay.onOpen(ws);
  return { ws, sent, closed };
}

const start = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le', ...extra });

const answer = (s: Sock): Promise<Sent> =>
  waitFor(() => s.sent.find((m) => m.type === 'ready' || m.type === 'unavailable'), {
    describe: `an answer to start (got ${JSON.stringify(s.sent.map((m) => m.type))})`,
  });

describe('taking a meeting over from an older socket', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-takeover-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const relayOn = (store: MeetingStore) => {
    const e = engine();
    return {
      ...e,
      relay: new MeetingRelay({ store, engines: [e.engine], notes: null, broadcast: () => {} }),
    };
  };

  it('a Record press from the same person resumes the meeting the quiet socket held', async () => {
    const store = new MeetingStore(dataDir);
    const { relay, sessions } = relayOn(store);
    const docId = 'harborlight-planning';

    const old = socket(relay, docId, ALICE);
    relay.onText(old.ws, start());
    const first = await answer(old);
    expect(first.type).toBe('ready');
    sessions[0]?.onTurn({ turn: 0, text: 'Before the phone slept.', final: true });

    // The page came back and Alice pressed Record: a fresh start, no resume.
    const fresh = socket(relay, docId, ALICE);
    relay.onText(fresh.ws, start());
    const back = await answer(fresh);
    expect(back.type).toBe('ready');
    expect(back.meetingId).toBe(first.meetingId);
    expect(back.resumed).toBe(true);

    // The old socket was told and closed, so it cannot resume back over this.
    expect(old.sent.some((m) => m.type === 'error')).toBe(true);
    expect(old.closed.length).toBe(1);
    // Its own close then arrives from the transport and changes nothing.
    relay.onClose(old.ws, old.closed[0]);
    await Promise.resolve();
    expect(store.active(docId)?.meetingId).toBe(String(first.meetingId));

    // One meeting, its transcript appended to rather than started again.
    sessions[1]?.onTurn({ turn: 0, text: 'After it woke.', final: true });
    expect(listMeetings(dataDir, docId).length).toBe(1);
    const lines = readFileSync(
      meetingTranscriptPath(dataDir, docId, String(first.meetingId)),
      'utf8',
    )
      .split('\n')
      .filter((l) => l.includes('"text"'));
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('Before the phone slept.');
    expect(lines[1]).toContain('After it woke.');

    relay.onClose(fresh.ws, 1000);
    await relay.dispose();
  });

  it('a resume from the same person takes over at once instead of waiting it out', async () => {
    const store = new MeetingStore(dataDir);
    const { relay } = relayOn(store);
    const docId = 'riverbend-sync';
    const old = socket(relay, docId, ALICE);
    relay.onText(old.ws, start());
    const first = await answer(old);
    const again = socket(relay, docId, ALICE);
    relay.onText(again.ws, start({ resume: first.meetingId }));
    const back = await answer(again);
    expect(back.type).toBe('ready');
    expect(back.meetingId).toBe(first.meetingId);
    expect(back.resumed).toBe(true);
    relay.onClose(again.ws, 1000);
    relay.onClose(old.ws, 1006);
    await relay.dispose();
  });

  it('refuses a different person, and leaves the holder recording', async () => {
    const store = new MeetingStore(dataDir);
    const { relay } = relayOn(store);
    const docId = 'saltmarsh-retro';
    const old = socket(relay, docId, ALICE);
    relay.onText(old.ws, start());
    const first = await answer(old);
    // Bob also claims to be Alice in the frame. The claim is not the proof.
    const other = socket(relay, docId, BOB);
    relay.onText(other.ws, start({ participant: 'Alice', resume: first.meetingId }));
    const refused = await answer(other);
    expect(refused.type).toBe('unavailable');
    expect(refused.reason).toBe('already_recording');
    expect(old.closed.length).toBe(0);
    expect(store.active(docId)?.meetingId).toBe(String(first.meetingId));
    relay.onClose(other.ws, 1000);
    relay.onClose(old.ws, 1000);
    await relay.dispose();
  });

  it('refuses when either socket proved nobody', async () => {
    const store = new MeetingStore(dataDir);
    const { relay } = relayOn(store);
    const docId = 'harborlight-unproven';
    const old = socket(relay, docId);
    relay.onText(old.ws, start());
    await answer(old);
    const anon = socket(relay, docId);
    relay.onText(anon.ws, start());
    expect((await answer(anon)).type).toBe('unavailable');
    expect(old.closed.length).toBe(0);
    relay.onClose(anon.ws, 1000);
    relay.onClose(old.ws, 1000);

    const held = socket(relay, 'riverbend-unproven', ALICE);
    relay.onText(held.ws, start());
    await answer(held);
    const nobody = socket(relay, 'riverbend-unproven');
    relay.onText(nobody.ws, start());
    expect((await answer(nobody)).type).toBe('unavailable');
    expect(held.closed.length).toBe(0);
    relay.onClose(nobody.ws, 1000);
    relay.onClose(held.ws, 1000);
    await relay.dispose();
  });
});

describe('samePerson', () => {
  it('matches two proven identities with one id, and nothing else', () => {
    expect(samePerson(ALICE, { ...ALICE, name: 'Alice on her phone' })).toBe(true);
    expect(samePerson(ALICE, BOB)).toBe(false);
    expect(samePerson(ALICE, null)).toBe(false);
    expect(samePerson(undefined, ALICE)).toBe(false);
    expect(samePerson({ ...ALICE, kind: 'anon' }, { ...ALICE, kind: 'anon' })).toBe(false);
    expect(samePerson({ ...ALICE, id: '' }, { ...ALICE, id: '' })).toBe(false);
  });
});

describe('the audio upgrade', () => {
  /** The route alone, with a server that records what each socket carried. */
  const upgradeAs = (author: User | null): UpgradeData | undefined => {
    let data: UpgradeData | undefined;
    const stream = createUpgradeStream({
      server: {
        upgrade: (_req: Request, o: { data: UpgradeData }) => {
          data = o.data;
          return true;
        },
      },
      docStore: { get: (id: string) => ({ docId: id }) },
      isValidDocId: () => true,
      workspacesOfMember: () => ['w1'],
      policyFor: () => ({ allowedOrigins: [] }),
      requireSignInToWrite: false,
      j: (status: number, body: unknown) => Response.json(body, { status }),
    } as never);
    const url = new URL('http://localhost/workspaces/w1/docs/riverbend-notes/audio');
    const out = stream.serveUpgradeAndStreamRoutes({
      req: new Request(url),
      url,
      pathname: url.pathname,
      visitor: null,
      visitorShareId: null,
      visitorMemberKey: null,
      ownerProven: () => false,
      anyoneProven: () => false,
      browserProvedNobody: () => author === null,
      provenAuthor: () => author,
      widgetDoorGrant: null,
      widgetTokenProved: false,
    });
    expect(out?.kind).toBe('upgraded');
    return data;
  };

  it('stamps the identity the request proved, and nothing when it proved none', () => {
    expect(upgradeAs(ALICE)?.author).toEqual(ALICE);
    expect(upgradeAs(null)?.author ?? null).toBeNull();
  });
});
