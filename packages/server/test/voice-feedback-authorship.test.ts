/**
 * A spoken comment is attributed exactly as a typed one.
 *
 * The widget writes a voice comment through the same thread route as a typed
 * comment, carrying a `voice` note, so it gets the same author: the verified
 * session wins over the name the body claims. This drives a real sign-in, the
 * `/voice` socket that produces the words, and both kinds of post from that
 * one browser session, with sign-in-to-write ON. That is the deployment where
 * a staging run with nobody signed in shows an anonymous name.
 *
 * All fixtures are synthetic: the Riverbend register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailIdentityId } from '@claude-workspaces/core';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

setDefaultTimeout(30_000);

// The log sender masks the code unless this is set (`auth/code-sender.ts`).
// Set before the server boots; the flag is read per send.
process.env.CW_LOG_LOGIN_CODES = '1';

const EMAIL = 'reviewer@riverbend.example';
/** What the widget claims when nobody is signed in: an anonymous animal. */
const CLAIMED = { id: 'anon-narwhal', name: 'Anonymous Narwhal', kind: 'anon', color: '#888' };
const ANCHOR = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Save',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
};

type Frame = { type: string; [k: string]: unknown };
type Author = { id: string; name: string };
type ThreadPayload = {
  id: string;
  comments: Array<{ text: string; author: Author; voice?: { clip: string; raw: string } }>;
};

describe('a voice comment’s author', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let WS = '';
  const codes: string[] = [];
  const originalLog = console.log;

  beforeAll(async () => {
    console.log = (...args: unknown[]) => {
      const m = args
        .map(String)
        .join(' ')
        .match(/login code for \S+: (\d{6})/);
      if (m?.[1]) codes.push(m[1]);
      originalLog(...(args as []));
    };
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-author-'));
    handle = createServer({
      port: 0,
      dataDir,
      emailCodeSignIn: true,
      requireSignInToWrite: true,
      transcription: createMockTranscriptionEngine([{ words: ['the', 'save', 'button', 'hides'] }]),
    });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterAll(async () => {
    console.log = originalLog;
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The headers a page on this server sends, so the write gate applies. */
  const browser = (cookie?: string): Record<string, string> => ({
    'content-type': 'application/json',
    origin: base,
    ...(cookie ? { cookie } : {}),
  });

  async function signIn(): Promise<string> {
    const before = codes.length;
    const started = await fetch(`${base}/api/auth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL }),
    });
    expect(started.status).toBe(200);
    expect(codes.length).toBe(before + 1);
    const res = await fetch(`${base}/api/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, code: codes.at(-1) }),
    });
    expect(res.status).toBe(200);
    const pair = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    return pair;
  }

  /** One recording over the socket; the words it heard and the clip they came from. */
  async function speak(docId: string, cookie?: string): Promise<Frame[]> {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/${docId}/voice`, {
      headers: browser(cookie),
    } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    const frames: Frame[] = [];
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(ev.data as string) as Frame));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('voice socket refused')));
    });
    ws.send(JSON.stringify({ type: 'start', sampleRate: 16_000, targets: [] }));
    await waitFor(() => frames.find((f) => f.type === 'ready' || f.type === 'unavailable'), {
      describe: 'ready or unavailable',
    });
    if (frames.some((f) => f.type === 'ready')) {
      for (let i = 0; i < 5; i++) ws.send(new Uint8Array(640));
      await waitFor(() => frames.find((f) => f.type === 'comment'), { describe: 'a comment' });
      ws.send(JSON.stringify({ type: 'stop' }));
      await waitFor(() => frames.find((f) => f.type === 'stopped'), { describe: 'stopped' });
    }
    ws.close();
    return frames;
  }

  it('is the signed-in person, the same as a typed comment from that session', async () => {
    const file = join(dataDir, 'riverbend-mock.md');
    writeFileSync(file, '# Riverbend\n\nThe Save button.\n');
    const created = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'riverbend-mock', type: 'markdown', sourceUrl: file }),
    });
    expect(created.status).toBe(200);
    const docId = ((await created.json()) as { docId: string }).docId;
    const cookie = await signIn();

    const frames = await speak(docId, cookie);
    const spoken = frames.find((f) => f.type === 'comment');
    expect(spoken, JSON.stringify(frames)).toBeTruthy();

    const threads = `${base}/workspaces/${WS}/docs/${docId}/threads`;
    const typed = await fetch(threads, {
      method: 'POST',
      headers: browser(cookie),
      body: JSON.stringify({ author: CLAIMED, text: 'The Save button hides.', anchor: ANCHOR }),
    });
    expect(typed.status, await typed.clone().text()).toBe(200);
    const voiced = await fetch(threads, {
      method: 'POST',
      headers: browser(cookie),
      body: JSON.stringify({
        author: CLAIMED,
        text: String(spoken?.text),
        anchor: ANCHOR,
        voice: { clip: String(spoken?.clip), raw: String(spoken?.raw) },
      }),
    });
    expect(voiced.status, await voiced.clone().text()).toBe(200);

    const listed = (await (await fetch(threads)).json()) as { threads: ThreadPayload[] };
    const voice = listed.threads.flatMap((t) => t.comments).find((c) => c.voice);
    const plain = listed.threads.flatMap((t) => t.comments).find((c) => !c.voice);
    expect(voice?.voice?.raw).toBe('the save button hides');
    expect(plain?.author.id).toBe(emailIdentityId(EMAIL));
    expect(voice?.author, 'a spoken comment carries the typed comment’s author').toEqual(
      plain?.author as Author,
    );
    expect(voice?.author.name).not.toBe(CLAIMED.name);
  });

  it('CONTROL: with no session the browser cannot record or post, so nothing is anonymous', async () => {
    const file = join(dataDir, 'harborlight-mock.md');
    writeFileSync(file, '# Harborlight\n\nThe Save button.\n');
    const created = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'harborlight-mock', type: 'markdown', sourceUrl: file }),
    });
    const docId = ((await created.json()) as { docId: string }).docId;
    const frames = await speak(docId);
    expect(frames.find((f) => f.type === 'unavailable')).toMatchObject({
      reason: 'sign_in_required',
    });
    const refused = await fetch(`${base}/workspaces/${WS}/docs/${docId}/threads`, {
      method: 'POST',
      headers: browser(),
      body: JSON.stringify({ author: CLAIMED, text: 'The Save button hides.', anchor: ANCHOR }),
    });
    expect(refused.status).toBe(401);
  });
});
