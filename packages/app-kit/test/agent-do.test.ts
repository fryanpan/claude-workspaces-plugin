/**
 * The agent's edits and the live dashboard in a real workerd, through the
 * example Workers in `fixtures/`: an agent tool call edits a markdown-file
 * doc every page sees and the file receives; database writes reach every
 * view-role page as one debounced push, even across an eviction; a page
 * cannot write the dashboard; an agent can write a tile of its own.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DocSync, connectDoc } from '../src/client/sync.ts';
import { watchMap } from '../src/client/watch-map.ts';
import { until } from './poll.ts';
import { type LocalWorker, hibernate, startWorker } from './workerd-harness.ts';

let files: LocalWorker;
let dash: LocalWorker;
const open: DocSync[] = [];

beforeAll(async () => {
  files = await startWorker('file-worker.ts', { DOC: 'DocFile', FILES: 'FileStore' });
  dash = await startWorker('dashboard-worker.ts', { DASH: 'DashboardRoom' });
}, 60_000);

afterAll(async () => {
  for (const s of open) s.close();
  await files?.dispose();
  await dash?.dispose();
});

function page(url: string): DocSync {
  const sync = connectDoc(url, { retryMs: 50, maxRetryMs: 200 });
  open.push(sync);
  return sync;
}

/** A view-role page on one dashboard room, and every render it made. */
async function dashboardPage(room: string, user: string) {
  const sync = page(`${dash.ws}/rooms/${room}/ws?user=${user}&role=view`);
  await sync.synced;
  const renders: Record<string, unknown>[] = [];
  watchMap(sync.doc.getMap('tiles'), (v) => renders.push(v));
  return { sync, renders, last: () => renders.at(-1) ?? {} };
}

/** The push's figures, without the instance that made it. */
const figures = (tiles: Record<string, unknown>): string => {
  const { by: _by, ...rest } = (tiles.readings ?? {}) as Record<string, unknown>;
  return JSON.stringify(rest);
};

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: 'POST', body: JSON.stringify(body) });

describe('an agent edits a live doc', { timeout: 20_000 }, () => {
  it('reaches the open page and the file, and tells the agent what it got wrong', async () => {
    await fetch(`${files.http}/files/harborlight`, { method: 'PUT', body: 'Tide at noon.' });
    const a = page(`${files.ws}/docs/harborlight/ws?user=alice&role=edit`);
    await a.synced;
    const agentUrl = `${files.http}/docs/harborlight/agent?session=sess_01`;
    const ok = await post(agentUrl, { find: 'noon', replace: 'dusk' });
    expect(await ok.json()).toEqual({ ok: true });
    await until(
      'the page to see the edit',
      () => a.doc.getText('body').toString() === 'Tide at dusk.',
    );
    await until(
      'the file to be written',
      async () =>
        (await (await fetch(`${files.http}/files/harborlight`)).text()) === 'Tide at dusk.',
    );
    const miss = await post(agentUrl, { find: 'midnight', replace: 'x' });
    expect(((await miss.json()) as { error: string }).error).toBe('no-match');
  });
});

describe('a live dashboard', { timeout: 20_000 }, () => {
  it('turns a burst of writes into one push every view-role page renders', async () => {
    const alice = await dashboardPage('riverbend', 'alice');
    const bob = await dashboardPage('riverbend', 'bob');
    for (const value of [6, 7, 8]) await post(`${dash.http}/rooms/riverbend/readings`, { value });
    const pushed = JSON.stringify({ count: 3, mean: 7, pushes: 1 });
    await until('alice to render the push', () => figures(alice.last()) === pushed);
    await until('bob to render the push', () => figures(bob.last()) === pushed);
  });

  it("drops a view-role page's own write to the tiles", async () => {
    const alice = await dashboardPage('saltmarsh', 'alice');
    alice.sync.doc.getMap('tiles').set('forged', true);
    await post(`${dash.http}/rooms/saltmarsh/readings`, { value: 1 });
    const bob = await dashboardPage('saltmarsh', 'bob');
    await until('bob to render the push', () => 'readings' in bob.last());
    expect(Object.keys(bob.last())).toEqual(['readings']);
  });

  it('still pushes when the object is evicted inside the debounce', async () => {
    const alice = await dashboardPage('harborlight-evict', 'alice');
    const first = await (await fetch(`${dash.http}/rooms/harborlight-evict/instance`)).text();
    await post(`${dash.http}/rooms/harborlight-evict/readings`, { value: 4 });
    await hibernate(dash, 'DashboardRoom', 'harborlight-evict');
    expect(alice.last()).toEqual({});
    await until('the push', () => 'readings' in alice.last());
    expect(figures(alice.last())).toBe(JSON.stringify({ count: 1, mean: 4, pushes: 1 }));
    // Made by an instance the alarm woke, not by the evicted one.
    expect((alice.last().readings as { by: string }).by).not.toBe(first);
  });

  it('lets an agent write a tile of its own, and refuses one too large', async () => {
    const alice = await dashboardPage('riverbend-agent', 'alice');
    const agentUrl = `${dash.http}/rooms/riverbend-agent/agent?session=sess_02`;
    const ok = await post(agentUrl, { tile: 'note', value: 'Sleep improved this week.' });
    expect(await ok.json()).toEqual({ ok: true });
    await until(
      'alice to render the note',
      () => alice.last().note === 'Sleep improved this week.',
    );
    const big = await post(agentUrl, { tile: 'note', value: 'x'.repeat(70_000) });
    expect(((await big.json()) as { error: string }).error).toBe('too-large');
  });
});
