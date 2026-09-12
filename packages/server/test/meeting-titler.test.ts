/**
 * A meeting is named from its notes, only while nobody has named it.
 *
 * Driven through a real `DocStore` — the guard that matters is the store's
 * `setAutoTitle`, which reads who chose the title and writes the new one in
 * one step after the model call returns. A fake store could agree with the
 * titler about that and still be wrong about the store.
 *
 * The namer is a function the test holds open, so "a rename lands while the
 * call is out" is a state the test builds rather than a timing it hopes for.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocMeta } from '@claude-workspaces/core';
import { DocStore } from '../src/doc-store.ts';
import { parseMeetingTitle } from '../src/meeting-namer.ts';
import {
  type MeetingTitler,
  createMeetingTitler,
  retitleClockTitles,
} from '../src/meeting-titler.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { waitFor } from './wait-for.ts';

const TOPIC = 'Berth extension permit and crew schedule';

const NOTES_2 = `## Meeting notes

- The berth extension needs the county permit before the October pour
- The permit office wants the revised tide study attached
`;
const NOTES_3 = `${NOTES_2}- Night crew moves to Tuesdays and Thursdays while the crane is on site
`;
const NOTES_4 = `${NOTES_3}- Saltmarsh supplies the second barge from the 20th
`;

/** Let queued promise work run — enough for a naming chain to reach its call. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A namer the test answers by hand. */
function heldNamer() {
  const calls: string[] = [];
  const pending: Array<(title: string | null) => void> = [];
  return {
    calls,
    answer(title: string | null) {
      const next = pending.shift();
      if (!next) throw new Error('no namer call is waiting');
      next(title);
    },
    waiting: () => pending.length,
    namer: ({ notes }: { notes: string }) => {
      calls.push(notes);
      return new Promise<string | null>((resolve) => pending.push(resolve));
    },
  };
}

describe('parseMeetingTitle', () => {
  it('keeps a title and strips what a model decorates it with', () => {
    expect(parseMeetingTitle(`${TOPIC}`)).toBe(TOPIC);
    expect(parseMeetingTitle(`Title: "${TOPIC}."\n`)).toBe(TOPIC);
    expect(parseMeetingTitle(`\n**${TOPIC}**`)).toBe(TOPIC);
  });

  it('refuses a date, a paragraph and nothing', () => {
    expect(parseMeetingTitle('Meeting notes 2026-09-12 14:05')).toBeNull();
    expect(parseMeetingTitle('Standup at 9:30')).toBeNull();
    expect(
      parseMeetingTitle(
        'The team discussed the berth extension permit, the crew schedule, the barge and the budget line',
      ),
    ).toBeNull();
    expect(parseMeetingTitle('   \n  ')).toBeNull();
  });
});

describe('the meeting titler', () => {
  let dataDir: string;
  let store: DocStore;
  let held: ReturnType<typeof heldNamer>;
  let titler: MeetingTitler;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-title-'));
    store = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    held = heldNamer();
    titler = createMeetingTitler({ namer: held.namer, store: () => store });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const meeting = (docId: string, titleSource: 'default' | 'given' = 'default') => {
    store.getOrCreate(docId, {
      type: 'markdown',
      title: titleSource === 'default' ? 'Meeting' : 'Harborlight quarterly review',
      titleSource,
      huddle: true,
    });
  };
  const titleOf = (docId: string) => store.get(docId)?.meta;

  it('names the meeting at three bullets, once, and marks the title auto', async () => {
    meeting('d-early');
    store.setDocContent('d-early', NOTES_2);
    titler.onNotesLanded('d-early');
    await settle();
    expect(held.calls.length).toBe(0);

    store.setDocContent('d-early', NOTES_3);
    titler.onNotesLanded('d-early');
    await waitFor(() => held.calls.length === 1);
    expect(held.calls[0]).toContain('Night crew moves');
    held.answer(TOPIC);
    await waitFor(() => titleOf('d-early')?.title === TOPIC);
    expect(titleOf('d-early')?.titleSource).toBe('auto');

    // A fourth bullet in the same meeting asks nothing more.
    store.setDocContent('d-early', NOTES_4);
    titler.onNotesLanded('d-early');
    await settle();
    expect(held.calls.length).toBe(1);
  });

  it('a rename that lands during the namer call wins', async () => {
    meeting('d-race');
    store.setDocContent('d-race', NOTES_3);
    titler.onNotesLanded('d-race');
    await waitFor(() => held.waiting() === 1);

    // The person renames while the call is out.
    expect(store.setTitle('d-race', 'Crane hire').ok).toBe(true);
    const end = titler.onMeetingEnd('d-race');
    held.answer(TOPIC);
    // The at-stop naming queues behind the early one and sees the rename too.
    expect(await end).toBe('named');
    expect(titleOf('d-race')?.title).toBe('Crane hire');
    expect(titleOf('d-race')?.titleSource).toBe('person');
    // Recorded in the CRDT, which is what survives a restart and what the
    // editor reads — not only in the server's in-memory copy.
    const doc = store.get('d-race');
    expect(doc && readDocMeta(doc.ydoc).titleSource).toBe('person');
    expect(held.calls.length).toBe(1);
  });

  it('names again at the stop, over its own earlier topic', async () => {
    meeting('d-stop');
    store.setDocContent('d-stop', NOTES_3);
    titler.onNotesLanded('d-stop');
    await waitFor(() => held.waiting() === 1);
    held.answer('Berth permit');
    await waitFor(() => titleOf('d-stop')?.title === 'Berth permit');

    store.setDocContent('d-stop', NOTES_4);
    const end = titler.onMeetingEnd('d-stop');
    await waitFor(() => held.waiting() === 1);
    held.answer(TOPIC);
    expect(await end).toBe('renamed');
    expect(titleOf('d-stop')?.title).toBe(TOPIC);
  });

  it('never names a given title, a doc with no notes, or on a failed call', async () => {
    meeting('d-given', 'given');
    store.setDocContent('d-given', NOTES_4);
    titler.onNotesLanded('d-given');
    expect(await titler.onMeetingEnd('d-given')).toBe('named');

    meeting('d-empty');
    expect(await titler.onMeetingEnd('d-empty')).toBe('no-notes');
    expect(held.calls.length).toBe(0);

    meeting('d-fail');
    store.setDocContent('d-fail', NOTES_4);
    const end = titler.onMeetingEnd('d-fail');
    await waitFor(() => held.waiting() === 1);
    held.answer(null);
    expect(await end).toBe('failed');
    expect(titleOf('d-fail')?.title).toBe('Meeting');
    expect(titleOf('d-fail')?.titleSource).toBe('default');
  });
});

describe('retitleClockTitles', () => {
  let dataDir: string;
  let store: DocStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-retitle-'));
    store = new DocStore({
      dataDir,
      sse: new SseBus(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A doc from before `titleSource` existed. */
  const legacy = (
    docId: string,
    title: string,
    opts: { huddle?: boolean; notes?: string; kind?: 'plan' } = {},
  ) => {
    store.getOrCreate(docId, {
      type: 'markdown',
      title,
      ...(opts.huddle === false ? {} : { huddle: true }),
      ...(opts.kind ? { huddleKind: opts.kind } : {}),
    });
    if (opts.notes) store.setDocContent(docId, opts.notes);
  };
  const meta = (docId: string) => store.get(docId)?.meta;

  it('renames clock titles to the topic or the default, and leaves every other title alone', async () => {
    legacy('d-notes', 'Meeting notes 2026-09-03 10:15', { notes: NOTES_4 });
    legacy('d-plan', 'Plan 2026-09-03 11:00', { kind: 'plan' });
    legacy('d-bare', 'Meeting notes 2026-09-04 09:00');
    legacy('d-person', 'Riverbend dock survey', { notes: NOTES_4 });
    legacy('d-other', 'Meeting notes 2026-09-03 10:15', { huddle: false, notes: NOTES_4 });
    store.getOrCreate('d-renamed', { type: 'markdown', title: 'Meeting', huddle: true });
    store.setTitle('d-renamed', 'Meeting notes 2026-09-05 08:00');
    // A calendar meeting's doc: no huddle flag, a `meeting-` alias.
    store.getOrCreate('d-cal', {
      type: 'markdown',
      title: 'Meeting 2026-09-01 14:05',
      alias: 'meeting-20260901-1405-abcd',
    });

    const asked: string[] = [];
    const namer = async ({ notes }: { notes: string }) => {
      asked.push(notes);
      return TOPIC;
    };
    const result = await retitleClockTitles(store, namer);

    expect(result).toEqual({ renamed: 4, skipped: 0 });
    expect(Object.keys(result).sort()).toEqual(['renamed', 'skipped']);
    expect(meta('d-notes')?.title).toBe(TOPIC);
    expect(meta('d-notes')?.titleSource).toBe('auto');
    expect(meta('d-plan')?.title).toBe('Planning Meeting');
    expect(meta('d-plan')?.titleSource).toBe('default');
    expect(meta('d-bare')?.title).toBe('Meeting');
    expect(meta('d-cal')?.title).toBe('Meeting');
    expect(meta('d-person')?.title).toBe('Riverbend dock survey');
    expect(meta('d-other')?.title).toBe('Meeting notes 2026-09-03 10:15');
    expect(meta('d-renamed')?.title).toBe('Meeting notes 2026-09-05 08:00');
    // Only the one meeting with notes cost a call.
    expect(asked.length).toBe(1);

    // Idempotent: nothing still reads as a clock title.
    expect(await retitleClockTitles(store, namer)).toEqual({ renamed: 0, skipped: 0 });
  });

  it('skips a meeting with notes when there is no topic, so a later run can name it', async () => {
    legacy('d-nokey', 'Meeting notes 2026-09-03 10:15', { notes: NOTES_4 });
    expect(await retitleClockTitles(store, null)).toEqual({ renamed: 0, skipped: 1 });
    expect(meta('d-nokey')?.title).toBe('Meeting notes 2026-09-03 10:15');
    expect(await retitleClockTitles(store, async () => TOPIC)).toEqual({ renamed: 1, skipped: 0 });
  });

  it('refuses a legacy doc whose title is no longer the one the retitle read', () => {
    legacy('d-moved', 'Riverbend dock survey');
    expect(
      store.setAutoTitle('d-moved', 'Meeting', 'default', {
        replacing: 'Meeting notes 2026-09-03 10:15',
      }),
    ).toEqual({ ok: false, error: 'named' });
    expect(meta('d-moved')?.title).toBe('Riverbend dock survey');
  });

  it('a rename that lands during the call wins over the retitle', async () => {
    legacy('d-race', 'Meeting notes 2026-09-03 10:15', { notes: NOTES_4 });
    const held = heldNamer();
    const run = retitleClockTitles(store, held.namer);
    await waitFor(() => held.waiting() === 1);
    store.setTitle('d-race', 'Harborlight crane hire');
    held.answer(TOPIC);
    expect(await run).toEqual({ renamed: 0, skipped: 1 });
    expect(meta('d-race')?.title).toBe('Harborlight crane hire');
  });
});
