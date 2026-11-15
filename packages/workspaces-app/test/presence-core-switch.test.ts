/**
 * `presence-core-switch.ts`: which strip the board draws as the collab core
 * setting moves, and the three ways the page reads it.
 *
 * The board-level cases are `presence-strip-webawesome.test.ts`; these pin
 * the parts a boot cannot reach on purpose — a load that a later flip
 * overtakes, a chunk that fails to load, and a frame or record that does not
 * say what it should.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceChip } from '../src/board/board-presence-model.ts';
import {
  collabCoreActive,
  collabCoreOf,
  listenCollabCore,
  mountBoardPresence,
  rereadCollabCore,
} from '../src/board/presence-core-switch.ts';
import { presenceData } from '../src/board/presence-island.tsx';

const tick = () => new Promise((r) => setTimeout(r, 0));

const alice: PresenceChip = {
  key: 'p-Alice',
  label: 'Alice',
  kind: 'person',
  where: 'board',
  title: 'Alice · in board · just now',
};

/** A stand-in for the Web Awesome module whose load the test resolves. */
function deferredLoad() {
  const loads: Array<(ok: boolean) => void> = [];
  const mounted: string[] = [];
  const load = () =>
    new Promise<{
      mountWaPresenceIsland: (host: HTMLElement) => () => void;
    }>((resolve, reject) => {
      loads.push((ok) =>
        ok
          ? resolve({
              mountWaPresenceIsland: (host) => {
                const marker = document.createElement('i');
                marker.className = 'stand-in-wa';
                host.appendChild(marker);
                mounted.push('wa');
                return () => marker.remove();
              },
            })
          : reject(new Error('chunk 404')),
      );
    });
  return { load, loads, mounted };
}

let host: HTMLElement;
let dispose: () => void = () => {};
beforeEach(() => {
  collabCoreActive.value = false;
  presenceData.value = { chips: [alice], followedKey: null };
  host = document.createElement('div');
  host.className = 'board-presence board-people';
  document.body.appendChild(host);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const face = () =>
  host.querySelector('.stand-in-wa')
    ? 'wa'
    : host.querySelector('.board-presence-circle')
      ? 'classic'
      : 'none';

describe('mountBoardPresence', () => {
  it('draws today’s strip, swaps to the loaded one when the setting turns on, and back', async () => {
    const d = deferredLoad();
    dispose = mountBoardPresence(host, { onTap: vi.fn(), onLongPress: vi.fn() }, d.load);
    await tick();
    expect(face()).toBe('classic');

    collabCoreActive.value = true;
    expect(face(), 'still today’s while the chunk loads').toBe('classic');
    d.loads[0]?.(true);
    await tick();
    expect(face()).toBe('wa');
    expect(host.querySelector('.board-presence-circle')).toBeNull();

    collabCoreActive.value = false;
    await tick();
    expect(face()).toBe('classic');
  });

  it('drops a load that a later flip overtook', async () => {
    const d = deferredLoad();
    dispose = mountBoardPresence(host, { onTap: vi.fn(), onLongPress: vi.fn() }, d.load);
    collabCoreActive.value = true;
    collabCoreActive.value = false;
    d.loads[0]?.(true);
    await tick();
    expect(face()).toBe('classic');
    expect(d.mounted).toEqual([]);
  });

  it('keeps today’s strip when the chunk fails to load', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deferredLoad();
    dispose = mountBoardPresence(host, { onTap: vi.fn(), onLongPress: vi.fn() }, d.load);
    collabCoreActive.value = true;
    d.loads[0]?.(false);
    await tick();
    expect(face()).toBe('classic');
    expect(errors).toHaveBeenCalled();
  });
});

describe('reading the setting', () => {
  it('reads the record and the frame, and anything else as off', () => {
    expect(collabCoreOf({ workspace: {}, collabCore: { active: true } })).toBe(true);
    expect(collabCoreOf({ workspace: {}, collabCore: { active: false } })).toBe(false);
    expect(collabCoreOf({ event: 'collab-core.changed', active: true })).toBe(true);
    expect(collabCoreOf({ workspace: {} })).toBe(false);
    expect(collabCoreOf({ collabCore: { active: 'yes' } })).toBe(false);
    expect(collabCoreOf(null)).toBe(false);
  });

  it('applies a collab-core.changed frame, and ignores one it cannot read', () => {
    const stream = new EventTarget();
    listenCollabCore(stream);
    const frame = (data: string) =>
      stream.dispatchEvent(Object.assign(new Event('collab-core.changed'), { data }));
    frame(JSON.stringify({ event: 'collab-core.changed', active: true }));
    expect(collabCoreActive.value).toBe(true);
    frame('{not json');
    expect(collabCoreActive.value).toBe(true);
    frame(JSON.stringify({ event: 'collab-core.changed', active: false }));
    expect(collabCoreActive.value).toBe(false);
  });

  it('re-reads the record, and a failed read changes nothing', async () => {
    const answer = (status: number, body: unknown) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status }));
    const ok = answer(200, { workspace: {}, collabCore: { active: true } });
    await rereadCollabCore('riverbend', ok as unknown as typeof fetch);
    expect(ok).toHaveBeenCalledWith('/workspaces/riverbend?format=json');
    expect(collabCoreActive.value).toBe(true);

    await rereadCollabCore('riverbend', answer(503, {}) as unknown as typeof fetch);
    expect(collabCoreActive.value).toBe(true);
    const offline = vi.fn(async () => {
      throw new TypeError('offline');
    });
    await rereadCollabCore('riverbend', offline as unknown as typeof fetch);
    expect(collabCoreActive.value).toBe(true);
  });
});
