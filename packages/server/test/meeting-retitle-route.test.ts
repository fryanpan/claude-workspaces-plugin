/**
 * `POST /api/meetings/retitle` through the real server: the one-time rename
 * of meetings still titled by their start clock.
 *
 * The decisions are `meeting-titler.test.ts`'s; this file is the half only the
 * route can get wrong — that it reaches the server's own namer, that it answers
 * with counts and nothing a person's meetings were called, and that it refuses
 * every caller that is not an agent on the box.
 *
 * The namer is a stub; no network. Every name is fictional.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubNotesComposer } from '../src/meeting-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const TOPIC = 'Harborlight berth permit';

let handle: ServerHandle;
let base: string;
let dataDir: string;
const named: string[] = [];

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cw-retitle-route-'));
  handle = createServer({
    port: 0,
    dataDir,
    meetingNotes: {
      composer: createStubNotesComposer(),
      titleNamer: async ({ notes }) => {
        named.push(notes);
        return TOPIC;
      },
    },
  });
  base = `http://127.0.0.1:${handle.port}`;
  const store = handle.docStore;
  store.getOrCreate('d-talk', {
    type: 'markdown',
    title: 'Meeting notes 2026-09-03 10:15',
    huddle: true,
  });
  store.setDocContent(
    'd-talk',
    '## Meeting notes\n\n- The permit office wants the revised tide study\n',
  );
  store.getOrCreate('d-quiet', {
    type: 'markdown',
    title: 'Plan 2026-09-04 09:00',
    huddle: true,
    huddleKind: 'plan',
  });
  store.getOrCreate('d-kept', { type: 'markdown', title: 'Saltmarsh barge dates', huddle: true });
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const retitle = (headers: Record<string, string> = {}) =>
  fetch(`${base}/api/meetings/retitle`, { method: 'POST', headers });

describe('POST /api/meetings/retitle', () => {
  it('refuses a browser, a proxied request and a GET, and renames nothing', async () => {
    // A browser is turned away before the route (sign-in) or by it (403).
    expect([401, 403]).toContain((await retitle({ origin: base })).status);
    expect((await retitle({ 'cf-ray': '8a1b2c3d4e5f-SJC' })).status).toBe(403);
    expect((await fetch(`${base}/api/meetings/retitle`)).status).toBe(405);
    expect(handle.docStore.get('d-talk')?.meta.title).toBe('Meeting notes 2026-09-03 10:15');
    expect(named.length).toBe(0);
  });

  it('renames through the server namer and answers with counts only', async () => {
    const r = await retitle();
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body).toEqual({ renamed: 2, skipped: 0 });
    expect(handle.docStore.get('d-talk')?.meta.title).toBe(TOPIC);
    expect(handle.docStore.get('d-quiet')?.meta.title).toBe('Planning Meeting');
    expect(handle.docStore.get('d-kept')?.meta.title).toBe('Saltmarsh barge dates');
    expect(named.length).toBe(1);

    // A second run finds nothing left to do.
    expect(await (await retitle()).json()).toEqual({ renamed: 0, skipped: 0 });
  });
});
