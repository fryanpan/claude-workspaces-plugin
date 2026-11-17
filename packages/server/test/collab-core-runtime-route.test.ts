/**
 * The collab core's server-wide setting, switched at runtime through
 * `POST /workspaces/<id>/collab-core` (`collab-core-switch.ts`).
 *
 * Off by default. Turning it on needs the owner's own proof, like turning a
 * board on; turning it off is a narrowing any local caller may make. No share
 * visitor reaches either. An environment that fixes it (`CW_COLLAB_CORE`,
 * here `ServerOptions.collabCore`) wins, so an operator can always force it
 * off. Every board page already open hears the change without a reload.
 *
 * Every name and address is invented. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { type ShareProofServer, post, startShareProofServer } from './share-proof-harness.ts';
import { type Frame, listenFrames } from './sse-frames.ts';
import { waitFor } from './wait-for.ts';

const VISITOR = 'riverbend@harborlight.example';
const servers: ShareProofServer[] = [];
const streams: Array<{ stop: () => unknown }> = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.stop();
  for (const s of servers.splice(0)) await s.stop();
});

async function boot(collabCore?: boolean): Promise<ShareProofServer> {
  const s = await startShareProofServer(
    'Harborlight',
    collabCore === undefined ? {} : { collabCore },
  );
  servers.push(s);
  return s;
}

async function record(s: ShareProofServer): Promise<Record<string, unknown>> {
  const r = await s.local(`${s.scope}?format=json`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { collabCore: Record<string, unknown> }).collabCore;
}

/** A board page's event stream, as a second open page holds it. */
async function pageFrames(s: ShareProofServer) {
  const res = await s.local(`${s.scope}/events:stream`, {
    headers: { accept: 'text/event-stream' },
  });
  const frames = listenFrames(res);
  streams.push(frames);
  return frames;
}

const flips = (frames: readonly Frame[]) =>
  frames.filter((f) => f.event === 'collab-core.changed').map((f) => f.data?.active);

describe('the runtime server-wide switch', () => {
  it('is off by default, and refuses on without the owner’s proof', async () => {
    const s = await boot();
    const sw = s.handle.collabCore.switch;
    expect(await record(s)).toEqual({ active: false, on: false, serverWide: false, fixed: null });

    const local = await s.local(`${s.scope}/collab-core`, post({ on: true, serverWide: true }));
    expect(local.status).toBe(403);
    expect(((await local.json()) as { error: string }).error).toBe('owner-proof-required');
    expect(sw.serverWide).toBe(false);
    expect(sw.boardOn(s.board)).toBe(false);
    // The server-wide half alone is a widening of its own.
    const alone = await s.local(`${s.scope}/collab-core`, post({ serverWide: true }));
    expect(alone.status).toBe(403);
    expect(sw.serverWide).toBe(false);

    const bad = await s.local(`${s.scope}/collab-core`, post({ serverWide: 'yes' }));
    expect(bad.status).toBe(400);
  });

  it('refuses a share visitor either way', async () => {
    const s = await boot();
    s.handle.shareLinks.addToAudience(s.board, ['@harborlight.example'], 'Alice');
    expect(await s.join(VISITOR)).toBe(302);
    for (const serverWide of [true, false]) {
      const r = await s.visitor(VISITOR, `${s.scope}/collab-core`, post({ serverWide }));
      expect(r.status).toBe(403);
    }
    expect(s.handle.collabCore.switch.serverWide).toBe(false);
  });

  it('moves the board in one owner request, and an open page hears it without a reload', async () => {
    const s = await boot();
    const sw = s.handle.collabCore.switch;
    const page = await pageFrames(s);

    const on = await s.owner(`${s.scope}/collab-core`, post({ on: true, serverWide: true }));
    expect(on.status, await on.clone().text()).toBe(200);
    expect(await on.json()).toMatchObject({ active: true, on: true, serverWide: true });
    expect(sw.usesCore(s.board)).toBe(true);
    await waitFor(() => flips(page.frames).length === 1, { describe: 'the page hears on' });
    expect(flips(page.frames)).toEqual([true]);
    expect(await record(s)).toEqual({ active: true, on: true, serverWide: true, fixed: null });

    // Off server-wide is a narrowing: loopback applies it, the board keeps its
    // own setting, and the page hears the board leave the core.
    const off = await s.local(`${s.scope}/collab-core`, post({ serverWide: false }));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ active: false, on: true, serverWide: false });
    await waitFor(() => flips(page.frames).length === 2, { describe: 'the page hears off' });
    expect(flips(page.frames)).toEqual([true, false]);
  });

  it('loses to an environment that fixes it off', async () => {
    const s = await boot(false);
    const sw = s.handle.collabCore.switch;
    expect(await record(s)).toMatchObject({ active: false, fixed: 'off' });

    const r = await s.owner(`${s.scope}/collab-core`, post({ on: true, serverWide: true }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('fixed-by-environment');
    // Refused whole: the board's own setting did not move either.
    expect(sw.boardOn(s.board)).toBe(false);

    // The board's own setting alone is still the owner's to set, and the
    // environment still keeps it off the core.
    const board = await s.owner(`${s.scope}/collab-core`, post({ on: true }));
    expect(board.status).toBe(200);
    expect(await board.json()).toMatchObject({ active: false, on: true, serverWide: false });
    expect(sw.usesCore(s.board)).toBe(false);
  });
});
