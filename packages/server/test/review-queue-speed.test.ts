/**
 * `GET /api/review-queue` over boards the plan lead has ranked.
 *
 * The route took 2.2s a call on the 6,000-key fixture: every ranked item asks
 * the coach's privacy check whether its place is off, the check asks the repo
 * registry for the key of every doc on the item's board, and the registry
 * answered by walking all of its keys. The registry now looks a doc up.
 *
 * These cases pin what the queue answers, so a faster path cannot change it:
 * the same items in the same order as the walk gave, with the local-only
 * board's ranks still not counting, and every change to an item reaching the
 * next read. Fixtures are invented; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrossReviewItem } from '../src/cross-review-queue.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  FIXTURE_AGENT,
  FIXTURE_PERSON,
  SMALL_FIXTURE,
  type SeededFixture,
  describeItem,
  seedReviewQueueFixture,
} from './review-queue-fixture.ts';

let dataDir: string;
let handle: ServerHandle;
let base: string;
let fx: SeededFixture;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'review-queue-speed-'));
  fx = await seedReviewQueueFixture(dataDir, { ...SMALL_FIXTURE, extraDocKeys: 500 });
  handle = createServer({ port: 0, dataDir, spawnerAgentId: null });
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const queue = async (): Promise<CrossReviewItem[]> => {
  const res = await fetch(`${base}/api/review-queue`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: CrossReviewItem[] }).items;
};

/**
 * The registry's answer as it was computed before the lookup: a walk over
 * every key, the first current one winning and the first aliased one the
 * fallback.
 */
function walkPrimaryKey(h: ServerHandle, docId: string): string | undefined {
  const { docKeys } = h.docStore.repos.snapshot();
  let aliased: string | undefined;
  for (const [key, held] of Object.entries(docKeys)) {
    if (held !== docId) continue;
    if (h.docStore.repos.resolveKey(key) === key) return key;
    aliased ??= key;
  }
  return aliased;
}

describe('the review queue over ranked boards', () => {
  it('answers the items, ranks, tags and order the old walk answered', async () => {
    const repos = handle.docStore.repos;
    const lookup = repos.primaryKeyFor.bind(repos);
    let walked: CrossReviewItem[];
    repos.primaryKeyFor = (docId) => walkPrimaryKey(handle, docId);
    try {
      walked = await queue();
    } finally {
      repos.primaryKeyFor = lookup;
    }
    const items = await queue();
    expect(items).toEqual(walked);

    // The ranked items lead, in rank order. Ranks 1-3 were written on the
    // Saltmarsh board, which is local-only, so they do not count.
    const ranked = items.filter((i) => i.leadRank !== undefined).map(describeItem);
    expect(ranked).toEqual([
      'Riverbend board | task-thread | Riverbend, which Riverbend chart for shoal 9? | easy rank=4 tag=not-this-week',
      'Riverbend board | doc-thread | Riverbend, ready to publish Riverbend plan 1? | easy rank=5 tag=urgent',
      'Harborlight board | task-review | Which Harborlight gauge for chart 1? | easy rank=6 tag=not-this-week',
      'Harborlight board | doc-thread | Riverbend, ready to publish Harborlight plan 2? | easy rank=7 tag=not-this-week',
      'Harborlight board | doc-thread | Riverbend, ready to publish Harborlight plan 0? | easy rank=8 tag=urgent',
    ]);
    expect(items.slice(0, ranked.length).map(describeItem)).toEqual(ranked);
    // Then everything else, top project first. Two asks filed in the same
    // millisecond on one board tie-break on a generated id, so inside a
    // board this compares the set and the board order, not the sequence.
    const rest = items.slice(ranked.length);
    expect(rest.map(describeItem).sort()).toEqual(
      [
        'Harborlight board | doc-thread | Riverbend, ready to publish Harborlight plan 1? | easy',
        'Harborlight board | task-thread | Riverbend, which Harborlight chart for shoal 9? | easy',
        'Riverbend board | doc-thread | Riverbend, ready to publish Riverbend plan 0? | easy',
        'Riverbend board | doc-thread | Riverbend, ready to publish Riverbend plan 2? | easy',
        'Riverbend board | task-review | Which Riverbend gauge for chart 1? | easy',
        'Saltmarsh board | doc-thread | Riverbend, ready to publish Saltmarsh plan 0? | easy',
        'Saltmarsh board | doc-thread | Riverbend, ready to publish Saltmarsh plan 1? | easy',
        'Saltmarsh board | doc-thread | Riverbend, ready to publish Saltmarsh plan 2? | easy',
        'Saltmarsh board | task-review | Which Saltmarsh gauge for chart 1? | easy',
        'Saltmarsh board | task-thread | Riverbend, which Saltmarsh chart for shoal 9? | easy',
      ].sort(),
    );
    const boardsInOrder = rest.map((i) => i.project).filter((p, i, a) => a[i - 1] !== p);
    expect(boardsInOrder).toEqual(['Saltmarsh board', 'Riverbend board', 'Harborlight board']);
  });

  it('shows a new, revised, answered and withdrawn item on the next read', async () => {
    const t = handle.tasks;
    const task = fx.itemTask.Riverbend;
    const asks = async () => (await queue()).map((i) => i.ask);

    const filed = t.addReviewItem(
      task,
      {
        shape: 'decision',
        headline: 'Does the Riverbend ferry run at neap tide?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
      { actor: FIXTURE_AGENT },
    );
    if (!filed.ok) throw new Error('review item not added');
    expect(await asks()).toContain('Does the Riverbend ferry run at neap tide?');

    const revised = t.reviseReviewItem(
      task,
      filed.item.id,
      { headline: 'Does the Riverbend ferry run at spring tide?' },
      { actor: FIXTURE_AGENT },
    );
    expect(revised.ok).toBe(true);
    const afterRevise = await asks();
    expect(afterRevise).toContain('Does the Riverbend ferry run at spring tide?');
    expect(afterRevise).not.toContain('Does the Riverbend ferry run at neap tide?');

    const res = await fetch(
      `${base}/workspaces/${fx.boards.Riverbend}/tasks/${task}/review-items/${filed.item.id}/answer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Yes', answeredWith: 'yes', author: FIXTURE_PERSON }),
      },
    );
    expect(res.status).toBe(200);
    expect(await asks()).not.toContain('Does the Riverbend ferry run at spring tide?');

    const second = t.addReviewItem(
      task,
      {
        shape: 'decision',
        headline: 'Which Saltmarsh pier takes the ferry?',
        options: [
          { id: 'north', label: 'North pier' },
          { id: 'south', label: 'South pier' },
        ],
      },
      { actor: FIXTURE_AGENT },
    );
    if (!second.ok) throw new Error('review item not added');
    expect(await asks()).toContain('Which Saltmarsh pier takes the ferry?');
    expect(t.withdrawReviewItem(task, second.item.id, { actor: FIXTURE_AGENT }).ok).toBe(true);
    expect(await asks()).not.toContain('Which Saltmarsh pier takes the ferry?');
  });
});
