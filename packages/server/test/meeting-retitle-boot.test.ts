/**
 * The one-time rename of meetings still titled by their start clock, as the
 * pass every server boot runs.
 *
 * The decisions are `meeting-titler.test.ts`'s; this file is the half only a
 * real boot can get wrong — that the pass runs at all once the port is bound,
 * that it reaches the server's own namer, that its one log line carries the
 * count and nothing a person's meetings were called, and that the next boot
 * over the same data finds nothing to do.
 *
 * The namer is a stub; no network. Every name is fictional.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { createStubNotesComposer } from '../src/meeting-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

const TOPIC = 'Harborlight berth permit';
const TALK = 'Meeting notes 2026-09-03 10:15';
const QUIET = 'Plan 2026-09-04 09:00';
const KEPT = 'Saltmarsh barge dates';

let dataDir: string;
let handle: ServerHandle | null = null;
let lines: string[];
let named: string[];
let logSpy: ReturnType<typeof spyOn>;

/** Docs from before `titleSource` existed, written by a store that then stops. */
function seedLegacyDocs(): void {
  const store = new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
  store.getOrCreate('d-talk', { type: 'markdown', title: TALK, huddle: true });
  store.setDocContent(
    'd-talk',
    '## Meeting notes\n\n- The permit office wants the revised tide study\n',
  );
  store.getOrCreate('d-quiet', {
    type: 'markdown',
    title: QUIET,
    huddle: true,
    huddleKind: 'plan',
  });
  store.getOrCreate('d-kept', { type: 'markdown', title: KEPT, huddle: true });
  store.flush();
  store.stop();
}

const boot = (): ServerHandle =>
  createServer({
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

const titleLines = () => lines.filter((l) => l.startsWith('[meeting-title]'));

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cw-retitle-boot-'));
  lines = [];
  named = [];
  logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  await handle?.stop();
  handle = null;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the clock-title rename at boot', () => {
  it('renames on the first boot, logs only the count, and finds nothing on the next', async () => {
    seedLegacyDocs();

    handle = boot();
    await waitFor(() => titleLines().length === 1, {
      describe: 'the first boot to log the rename',
    });
    expect(titleLines()).toEqual(['[meeting-title] renamed 2 old titles']);
    expect(handle.docStore.get('d-talk')?.meta.title).toBe(TOPIC);
    expect(handle.docStore.get('d-quiet')?.meta.title).toBe('Planning Meeting');
    expect(handle.docStore.get('d-kept')?.meta.title).toBe(KEPT);
    expect(named.length).toBe(1);
    await handle.stop();
    handle = null;

    handle = boot();
    await waitFor(() => titleLines().length === 2, {
      describe: 'the second boot to log the rename',
    });
    expect(titleLines()[1]).toBe('[meeting-title] renamed 0 old titles');
    expect(handle.docStore.get('d-talk')?.meta.title).toBe(TOPIC);
    expect(named.length).toBe(1);

    // Nothing a meeting was ever called reaches any line of the boot log, and
    // the pass's own lines carry no doc id either. (The boot filer names the
    // ids it files; that line predates this pass.)
    for (const title of [TALK, QUIET, KEPT, TOPIC]) {
      expect(lines.filter((l) => l.includes(title))).toEqual([]);
    }
    for (const id of ['d-talk', 'd-quiet', 'd-kept']) {
      expect(titleLines().filter((l) => l.includes(id))).toEqual([]);
    }
  });
});
