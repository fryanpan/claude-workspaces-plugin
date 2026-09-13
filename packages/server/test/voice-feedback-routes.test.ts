/**
 * Voice feedback through the REAL server: the `/voice` socket's guards and a
 * whole session over it, the log and recording it leaves behind served back
 * with byte ranges, and the `voice` note a posted comment carries.
 *
 * The engine is the mock one and no tidier is configured, so nothing here
 * reaches the network — the words land as said. All fixtures are synthetic —
 * the Riverbend register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShareTarget } from '../src/middleware/host-guard.ts';
import { handleDocVoiceFeedbackRoute } from '../src/routes/doc-voice-feedback.ts';
import type {
  DocResourceRouteRequest,
  DocRoutesContext,
} from '../src/routes/docs-routes-context.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';
import { appendVoiceLog, openWav, voiceAudioDir } from '../src/voice-feedback-store.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

setDefaultTimeout(30_000);

const AUTHOR = {
  id: 'known-riverbend',
  name: 'Riverbend Reviewer',
  kind: 'known',
  color: '#2e7dd7',
};
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
const UPGRADE = {
  upgrade: 'websocket',
  connection: 'upgrade',
  'sec-websocket-version': '13',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
};

interface Frame {
  type: string;
  [k: string]: unknown;
}

type CommentPayload = { id: string; text: string; voice?: { clip: string; raw: string } };
type ThreadPayload = { id: string; comments: CommentPayload[] };

describe('voice feedback routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let WS = '';

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const createDoc = async (name: string): Promise<string> => {
    const file = join(dataDir, `${name}.md`);
    writeFileSync(file, `# ${name}\n\nThe Save button.\n`);
    const res = await post(`/workspaces/${WS}/docs`, {
      docId: name,
      type: 'markdown',
      sourceUrl: file,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { docId: string }).docId;
  };

  const clipFor = (docId: string, seg = 1) =>
    `/workspaces/${WS}/docs/${docId}/voice-feedback/seg-${seg}.wav#t=0.0,1.5`;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-voice-routes-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine([{ words: ['the', 'save', 'button', 'hides'] }]),
    });
    base = `http://127.0.0.1:${handle.port}`;
    wsBase = `ws://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs a session over the socket and serves its recording and log back', async () => {
    const docId = await createDoc('riverbend-mock');
    const ws = new WebSocket(`${wsBase}/workspaces/${WS}/docs/${docId}/voice`);
    ws.binaryType = 'arraybuffer';
    const frames: Frame[] = [];
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(ev.data as string) as Frame));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('voice socket refused')));
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: 16_000,
        targets: [{ i: 0, tag: 'button', text: 'Save' }],
      }),
    );
    await waitFor(() => frames.find((f) => f.type === 'ready'), { describe: 'ready' });
    for (let i = 0; i < 5; i++) ws.send(new Uint8Array(640));
    const comment = await waitFor(() => frames.find((f) => f.type === 'comment'), {
      describe: 'a comment frame',
    });
    expect(comment).toMatchObject({ raw: 'the save button hides', target: null });
    expect(String(comment.clip)).toStartWith(
      `/workspaces/${WS}/docs/${docId}/voice-feedback/seg-1.wav#t=`,
    );
    ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => frames.find((f) => f.type === 'stopped'), { describe: 'stopped' });

    const full = await fetch(`${base}/workspaces/${WS}/docs/${docId}/voice-feedback/seg-1.wav`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('audio/wav');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    const bytes = new Uint8Array(await full.arrayBuffer());
    expect(bytes.byteLength).toBe(44 + 5 * 640);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');

    const part = await fetch(`${base}/workspaces/${WS}/docs/${docId}/voice-feedback/seg-1.wav`, {
      headers: { range: 'bytes=0-99' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-99/${44 + 5 * 640}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    const tail = await fetch(`${base}/workspaces/${WS}/docs/${docId}/voice-feedback/seg-1.wav`, {
      headers: { range: 'bytes=-10' },
    });
    expect(tail.status).toBe(206);
    expect((await tail.arrayBuffer()).byteLength).toBe(10);

    const past = await fetch(`${base}/workspaces/${WS}/docs/${docId}/voice-feedback/seg-1.wav`, {
      headers: { range: 'bytes=999999-' },
    });
    expect(past.status).toBe(416);

    const log = await fetch(`${base}/workspaces/${WS}/docs/${docId}/voice-feedback.md`);
    expect(log.status).toBe(200);
    expect(log.headers.get('content-type')).toContain('text/markdown');
    const text = await log.text();
    expect(text).toContain('## Recording 1');
    expect(text).toContain('the save button hides');
  });

  it('404s a recording name that is not one, and one that does not exist', async () => {
    const docId = await createDoc('harborlight-mock');
    for (const name of ['seg-x.wav', '..%2F..%2Fetc', 'seg-9.wav']) {
      const res = await fetch(`${base}/workspaces/${WS}/docs/${docId}/voice-feedback/${name}`);
      expect(res.status, name).toBe(404);
    }
    expect((await fetch(`${base}/workspaces/${WS}/docs/${docId}/voice-feedback.md`)).status).toBe(
      404,
    );
  });

  it('refuses share visitors at the handler, whatever admission lets through', async () => {
    const docId = 'riverbend-visited';
    appendVoiceLog(dataDir, docId, 'words\n');
    openWav(join(voiceAudioDir(dataDir, docId), 'seg-1.wav'), 16_000).close();
    const ctx = {
      dataDir,
      j: (status: number, body: unknown) => Response.json(body, { status }),
    } as unknown as DocRoutesContext;
    const call = (rest: string, visitor: ShareTarget | null, method = 'GET') =>
      handleDocVoiceFeedbackRoute(ctx, {
        req: new Request(`http://local/workspaces/w/docs/${docId}/${rest}`, { method }),
        visitor,
        rest,
        docId,
      } as unknown as DocResourceRouteRequest);
    const visitor = { workspaceId: 'riverbend' } as ShareTarget;

    expect((await call('voice-feedback/seg-1.wav', visitor))?.status).toBe(403);
    expect((await call('voice-feedback.md', visitor))?.status).toBe(403);
    // The control: the same request from a member is served.
    expect((await call('voice-feedback/seg-1.wav', null))?.status).toBe(200);
    expect((await call('voice-feedback.md', null))?.status).toBe(200);
    expect((await call('voice-feedback.md', null, 'POST'))?.status).toBe(405);
    // A path this handler does not claim is handed on.
    expect(await call('threads', null)).toBeUndefined();
  });

  it('refuses the voice upgrade for a foreign origin and for an unknown doc', async () => {
    const docId = await createDoc('guarded-mock');
    const foreign = await fetch(`${base}/workspaces/${WS}/docs/${docId}/voice`, {
      headers: { ...UPGRADE, origin: 'https://elsewhere.example.com' },
    });
    expect(foreign.status).toBe(403);
    const missing = await fetch(`${base}/workspaces/${WS}/docs/never-created/voice`, {
      headers: UPGRADE,
    });
    expect(missing.status).toBe(404);
  });

  it('stores a voice note on a posted comment and replaces it on an edit', async () => {
    const docId = await createDoc('noted-mock');
    const voice = { clip: clipFor(docId), raw: 'the save button hides' };
    const created = await post(`/workspaces/${WS}/docs/${docId}/threads`, {
      author: AUTHOR,
      text: 'The Save button hides.',
      anchor: ANCHOR,
      voice,
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const threadId = ((await created.json()) as { thread: ThreadPayload }).thread.id;

    const read = async (): Promise<CommentPayload | undefined> => {
      const listed = (await (
        await fetch(`${base}/workspaces/${WS}/docs/${docId}/threads`)
      ).json()) as {
        threads: ThreadPayload[];
      };
      return listed.threads.find((t) => t.id === threadId)?.comments[0];
    };
    const first = await read();
    expect(first?.voice).toEqual(voice);

    const grown = { clip: clipFor(docId, 2), raw: 'the save button hides behind the footer' };
    const edited = await post(`/workspaces/${WS}/docs/${docId}/threads/${threadId}/edit-comment`, {
      author: AUTHOR,
      commentId: first?.id,
      text: 'The Save button hides behind the footer.',
      voice: grown,
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const after = await read();
    expect(after?.text).toBe('The Save button hides behind the footer.');
    expect(after?.voice).toEqual(grown);

    const refused = await post(`/workspaces/${WS}/docs/${docId}/threads/${threadId}/edit-comment`, {
      author: AUTHOR,
      commentId: first?.id,
      text: 'Another wording.',
      voice: { clip: 'https://elsewhere.example/seg-1.wav#t=0,1', raw: 'x' },
    });
    expect(refused.status).toBe(400);
    expect((await read())?.voice).toEqual(grown);
  });

  it('refuses a voice note pointing at another doc or off this server', async () => {
    const docId = await createDoc('strict-mock');
    for (const clip of [
      clipFor('some-other-doc'),
      `http://elsewhere.example${clipFor(docId)}`,
      clipFor(docId).replace('#t=0.0,1.5', ''),
    ]) {
      const res = await post(`/workspaces/${WS}/docs/${docId}/threads`, {
        author: AUTHOR,
        text: 'The Save button hides.',
        anchor: ANCHOR,
        voice: { clip, raw: 'x' },
      });
      expect(res.status, clip).toBe(400);
    }
    const listed = (await (
      await fetch(`${base}/workspaces/${WS}/docs/${docId}/threads`)
    ).json()) as {
      threads: ThreadPayload[];
    };
    expect(listed.threads).toEqual([]);
  });
});
