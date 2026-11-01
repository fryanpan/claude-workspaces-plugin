/**
 * "Show estimates": one per-board setting, off on every board until somebody
 * turns it on (Bryan, 1 Nov: "default to having the setting off on all boards
 * and hide all estimation stuff on all screens behind that setting").
 *
 * What has to hold, and what each check would fail on:
 *
 *  - A BOARD THAT NEVER SET IT IS OFF. The settings read says `false` and the
 *    board doc carries no `showEstimates` key. Default it on anywhere and the
 *    first case fails.
 *  - IT IS STORED. A set survives a new store over the same data directory.
 *  - IT REACHES AN OPEN PAGE. Every open board reads its settings off the
 *    `ws:` doc, so a write must move the doc's `workspace` map — and clearing
 *    it must remove the key, not leave a stale `true` behind.
 *  - ONLY THE OWNER CHANGES IT. A member's write is refused and changes
 *    nothing; a malformed value is a 400 that changes nothing.
 *
 * Every name is invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/tasks.ts';
import {
  AGENT,
  type ShareProofServer,
  post,
  readJson,
  startShareProofServer,
} from './share-proof-harness.ts';
import { waitFor } from './wait-for.ts';

const MEMBER = 'alice@harborlight.example';

describe('the store', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('is off for a new board, on once set, and still on after a restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-show-estimates-'));
    dirs.push(dataDir);
    const store = new TaskStore({ dataDir, debounceMs: 5 });
    const ws = store.createWorkspace('Harborlight');
    expect(store.showEstimates(ws.id)).toBe(false);
    expect(store.setShowEstimates(ws.id, true, { actor: AGENT }).ok).toBe(true);
    expect(store.showEstimates(ws.id)).toBe(true);
    store.flush();
    const reopened = new TaskStore({ dataDir, debounceMs: 5 });
    expect(reopened.showEstimates(ws.id)).toBe(true);
    expect(reopened.setShowEstimates(ws.id, false, { actor: AGENT }).ok).toBe(true);
    expect(reopened.showEstimates(ws.id)).toBe(false);
  });

  it('answers a board that does not exist as not found, not as off', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cw-show-estimates-'));
    dirs.push(dataDir);
    const store = new TaskStore({ dataDir, debounceMs: 5 });
    expect(store.setShowEstimates('ws-missing', true, { actor: AGENT })).toEqual({
      ok: false,
      error: 'workspace-not-found',
    });
  });
});

describe('the settings route and the board doc', () => {
  let s: ShareProofServer;

  const read = async (): Promise<{ showEstimates: unknown }> =>
    readJson(await s.local(`${s.scope}/settings`));
  const projected = (): unknown =>
    s.handle.docStore.get(`ws:${s.board}`)?.ydoc.getMap('workspace').get('showEstimates');
  const projectedName = (): unknown =>
    s.handle.docStore.get(`ws:${s.board}`)?.ydoc.getMap('workspace').get('name');

  beforeAll(async () => {
    s = await startShareProofServer('Riverbend estimates');
    s.handle.shareLinks.addToAudience(s.board, [MEMBER], 'Bryan');
    expect(await s.join(MEMBER)).toBe(302);
  });
  afterAll(async () => {
    await s.stop();
  });

  it('reads off on a board that never set it, and projects no key', async () => {
    expect((await read()).showEstimates).toBe(false);
    // Positive control: the doc is projected, so a missing key is an absence.
    await waitFor(() => projectedName() !== undefined, { describe: 'the board doc' });
    expect(projected()).toBeUndefined();
  });

  it("refuses a member's write, and nothing moves", async () => {
    const res = await s.visitor(
      MEMBER,
      `${s.scope}/settings`,
      post({ showEstimates: true, author: { id: 'u-alice', name: 'Alice' } }, 'PUT'),
    );
    expect(res.status).toBe(403);
    expect((await read()).showEstimates).toBe(false);
  });

  it('refuses a value that is not true, false or null, and nothing moves', async () => {
    const res = await s.local(
      `${s.scope}/settings`,
      post({ showEstimates: 'yes', author: AGENT }, 'PUT'),
    );
    expect(res.status).toBe(400);
    expect((await read()).showEstimates).toBe(false);
  });

  it('turns on, reaches the board doc, and turns back off', async () => {
    const on = await s.local(
      `${s.scope}/settings`,
      post({ showEstimates: true, author: AGENT }, 'PUT'),
    );
    expect(on.status).toBe(200);
    expect(((await on.json()) as { showEstimates: unknown }).showEstimates).toBe(true);
    expect((await read()).showEstimates).toBe(true);
    await waitFor(() => projected() === true, { describe: 'showEstimates on the board doc' });

    // `null` restores the default, which is off.
    const off = await s.local(
      `${s.scope}/settings`,
      post({ showEstimates: null, author: AGENT }, 'PUT'),
    );
    expect(off.status).toBe(200);
    expect((await read()).showEstimates).toBe(false);
    await waitFor(() => projected() === undefined, { describe: 'the key removed' });
  });

  it('leaves the setting alone when a write names another field', async () => {
    await s.local(`${s.scope}/settings`, post({ showEstimates: true, author: AGENT }, 'PUT'));
    const res = await s.local(
      `${s.scope}/settings`,
      post({ parallelismCap: 3, author: AGENT }, 'PUT'),
    );
    expect(res.status).toBe(200);
    expect((await read()).showEstimates).toBe(true);
  });
});
