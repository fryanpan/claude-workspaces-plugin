/**
 * A scheduled run's output reaching Home (`task-run-output.ts`).
 *
 * The first block is end to end on a real server over a real git repo: a rule
 * declares its output folder through the schedule route, the loop fires, the
 * run closes, and a generator's burst of files lands on disk — sources in one
 * folder, two roundups in the declared one, an older roundup that is not this
 * run's. What is asserted is what a person meets: ONE item on the board's
 * review queue linking the run's files, the files still in the Library, the
 * link opening through the Library's own verb, the item leaving once every
 * file it links has been opened, and the next run that rewrites an opened
 * file still filing one.
 *
 * The second block drives the observer on a real store with instants set on
 * the rows, because replacement is about two runs a day apart and a wall
 * clock cannot hold that still. The files are still real, read by the real
 * lister. Fixtures are invented; the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type TaskReviewItem,
  type User,
  checkReviewPayload,
  isReviewItemOpen,
  reviewWithdrawn,
} from '@claude-workspaces/core';
import { createMarkdownLister } from '../src/library.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  type RunOutputStore,
  buildOutputReview,
  observeRunOutput,
} from '../src/task-run-output.ts';
import { SCHEDULER_ACTOR, createTaskScheduler } from '../src/task-scheduler.ts';
import { TaskStore } from '../src/tasks.ts';
import { seedGoalsOverHttp } from './goal-seed.ts';
import { DAY, MON, OWNER, instancesOf, seed } from './task-scheduler-seed.ts';

const PERSON: User = {
  id: 'known-harbour',
  name: 'Harbourmaster',
  kind: 'known',
  color: '#2e7dd7',
};
const MIN = 60_000;

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

/** Write a file into the repo with its bytes dated `atMs`. */
function writeAt(repo: string, rel: string, atMs: number): void {
  const path = join(repo, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `# ${rel}\n`);
  utimesSync(path, atMs / 1000, atMs / 1000);
}

const openOn = (items: TaskReviewItem[]) =>
  items.filter((i) => isReviewItemOpen(i) && !reviewWithdrawn(i.review));

describe("a scheduled run's output, end to end", () => {
  let dataDir: string;
  let repo: string;
  let handle: ServerHandle;
  let base: string;
  let ws: string;
  let now = Date.now();

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify(body),
    });
  const get = async <T>(path: string): Promise<T> =>
    (await (
      await fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } })
    ).json()) as T;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'run-output-data-'));
    repo = mkdtempSync(join(tmpdir(), 'run-output-repo-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'handbook.md'), '# Harbour handbook\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    handle = createServer({
      port: 0,
      dataDir,
      schedulerNow: () => now,
      schedulerTickMs: 3_600_000,
    });
    base = `http://127.0.0.1:${handle.port}`;
    const { workspace } = (await (
      await post('/workspaces', { name: 'Harbour Lights', goal: 'Keep the lamps lit.' })
    ).json()) as { workspace: { id: string } };
    ws = workspace.id;
    // The board's project is the repo its docs come from.
    const bound = await post(`/workspaces/${ws}/docs`, {
      docId: 'handbook',
      type: 'markdown',
      sourceUrl: join(repo, 'handbook.md'),
      title: 'Harbour handbook',
    });
    expect(bound.status).toBe(200);
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('files ONE item for a run that wrote a burst, which opens its files and leaves once they are opened', async () => {
    const G = await seedGoalsOverHttp(base, ws, [{ key: 'g1', title: '1. Lamps' }], PERSON);
    const { task: rule } = (await (
      await post(`/workspaces/${ws}/tasks`, {
        author: PERSON,
        title: 'Write the ferry roundup',
        goal: G.g1,
      })
    ).json()) as { task: { id: string } };
    const armed = await post(`/workspaces/${ws}/tasks/${rule.id}/schedule`, {
      author: PERSON,
      rule: { kind: 'every', everyMs: DAY },
      output: { folder: 'roundups' },
    });
    expect(armed.status).toBe(200);

    now = Date.now() + DAY + MIN;
    expect(handle.runScheduler()).toHaveLength(1);
    const [instance] = instancesOf(handle.tasks, ws, rule.id);
    if (!instance) throw new Error('no instance');

    // The run's writes, a second apart: three sources, then two roundups. An
    // older roundup from before the run is in the folder too.
    const c = instance.createdAt;
    writeAt(repo, 'clippings/heron-post.md', c + 1_000);
    writeAt(repo, 'clippings/marsh-ledger.md', c + 2_000);
    writeAt(repo, 'clippings/gull-gazette.md', c + 3_000);
    writeAt(repo, 'roundups/ferry-roundup-0302.md', c + 4_000);
    writeAt(repo, 'roundups/tide-tables-0302.md', c + 5_000);
    writeAt(repo, 'roundups/ferry-roundup-0301.md', c - DAY);
    const done = handle.tasks.transition(instance.id, 'done', { actor: OWNER });
    expect(done.ok).toBe(true);

    handle.runScheduler();
    // A second pass is not a second item.
    handle.runScheduler();
    const items = openOn(handle.tasks.listReviewItems(rule.id));
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.review.headline).toBe('New in roundups: tide-tables-0302.md and 1 more');
    const links = [
      ...(item?.review.detail ?? '').matchAll(/\]\((\/workspaces\/[^)]+library\?open=[^)]+)\)/g),
    ].map((m) => m[1] ?? '');
    const paths = links.map((l) => decodeURIComponent(l.split('?open=')[1] ?? ''));
    expect(paths).toEqual(['roundups/tide-tables-0302.md', 'roundups/ferry-roundup-0302.md']);

    // It is on the board's review queue, which is what Home draws.
    const queue = JSON.stringify(await get(`/workspaces/${ws}/review-items`));
    expect(queue).toContain('New in roundups: tide-tables-0302.md and 1 more');

    // The Library still lists the files, each openable as before.
    const lib = await get<{ files: { open?: string }[] }>(`/workspaces/${ws}/library/items`);
    const offered = lib.files.map((f) => f.open);
    expect(offered).toContain('roundups/tide-tables-0302.md');
    expect(offered).toContain('roundups/ferry-roundup-0302.md');

    // Opening one leaves the item up; opening both takes it down.
    const first = await post(`/workspaces/${ws}/library/open`, { path: paths[0] });
    expect(first.status).toBe(200);
    handle.runScheduler();
    expect(openOn(handle.tasks.listReviewItems(rule.id))).toHaveLength(1);
    // The same link a second time still opens the doc it now is.
    const again = await post(`/workspaces/${ws}/library/open`, { path: paths[0] });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { href?: string }).href).toBe(
      ((await first.json()) as { href?: string }).href,
    );
    expect((await post(`/workspaces/${ws}/library/open`, { path: paths[1] })).status).toBe(200);
    handle.runScheduler();
    expect(openOn(handle.tasks.listReviewItems(rule.id))).toHaveLength(0);
    expect(handle.tasks.listReviewItems(rule.id)).toHaveLength(1);

    // The next run rewrites a file somebody already opened. That is still
    // news, and opening it again is no sign it was read, so the item stands.
    // The rows are dated ten minutes on, because the store stamps real time
    // and the first run's files would otherwise sit inside this run too.
    now += DAY;
    expect(handle.runScheduler()).toHaveLength(1);
    const next = instancesOf(handle.tasks, ws, rule.id).at(-1);
    if (!next || next.id === instance.id) throw new Error('no second instance');
    next.createdAt = c + 10 * MIN;
    writeAt(repo, 'roundups/tide-tables-0302.md', c + 11 * MIN);
    expect(handle.tasks.transition(next.id, 'done', { actor: OWNER }).ok).toBe(true);
    const closing = next.transitions?.at(-1);
    if (closing) closing.ts = c + 12 * MIN;
    handle.runScheduler();
    handle.runScheduler();
    const news = openOn(handle.tasks.listReviewItems(rule.id)).filter((i) =>
      i.review.headline?.startsWith('New in'),
    );
    expect(news.map((i) => i.review.headline)).toEqual(['New in roundups: tide-tables-0302.md']);
  });

  it('sees a file written after somebody’s Library scan, which the page still has cached', async () => {
    const G = await seedGoalsOverHttp(base, ws, [{ key: 'g1', title: '1. Lamps' }], PERSON);
    const { task: rule } = (await (
      await post(`/workspaces/${ws}/tasks`, {
        author: PERSON,
        title: 'Write the tide note',
        goal: G.g1,
      })
    ).json()) as { task: { id: string } };
    const armed = await post(`/workspaces/${ws}/tasks/${rule.id}/schedule`, {
      author: PERSON,
      rule: { kind: 'every', everyMs: DAY },
      output: { folder: 'roundups' },
    });
    expect(armed.status).toBe(200);
    now = Date.now() + DAY + MIN;
    expect(handle.runScheduler()).toHaveLength(1);
    const [instance] = instancesOf(handle.tasks, ws, rule.id);
    if (!instance) throw new Error('no instance');

    // The Library is scanned before the run writes, and its page caches that.
    await get(`/workspaces/${ws}/library/items`);
    writeAt(repo, 'roundups/tide-note-0302.md', instance.createdAt + 1_000);
    expect(handle.tasks.transition(instance.id, 'done', { actor: OWNER }).ok).toBe(true);

    handle.runScheduler();
    expect(openOn(handle.tasks.listReviewItems(rule.id)).map((i) => i.review.headline)).toContain(
      'New in roundups: tide-note-0302.md',
    );
  });

  it('names no file of a local-only project, not even one a board doc already holds', async () => {
    const G = await seedGoalsOverHttp(base, ws, [{ key: 'g1', title: '1. Lamps' }], PERSON);
    const { task: rule } = (await (
      await post(`/workspaces/${ws}/tasks`, {
        author: PERSON,
        title: 'Write the tide note',
        goal: G.g1,
      })
    ).json()) as { task: { id: string } };
    expect(
      (
        await post(`/workspaces/${ws}/tasks/${rule.id}/schedule`, {
          author: PERSON,
          rule: { kind: 'every', everyMs: DAY },
          output: { folder: 'roundups' },
        })
      ).status,
    ).toBe(200);
    // A roundup somebody opened, so a doc of the board holds it.
    writeAt(repo, 'roundups/tide-note-0301.md', Date.now() - DAY);
    expect(
      (await post(`/workspaces/${ws}/library/open`, { path: 'roundups/tide-note-0301.md' })).status,
    ).toBe(200);
    const priv = await fetch(`${base}/api/mounts/privacy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify({ path: repo, privacy: 'local-only' }),
    });
    expect(priv.status).toBe(200);

    now = Date.now() + DAY + MIN;
    expect(handle.runScheduler()).toHaveLength(1);
    const [instance] = instancesOf(handle.tasks, ws, rule.id);
    if (!instance) throw new Error('no instance');
    writeAt(repo, 'roundups/tide-note-0301.md', instance.createdAt + 1_000);
    writeAt(repo, 'roundups/tide-note-0302.md', instance.createdAt + 2_000);
    expect(handle.tasks.transition(instance.id, 'done', { actor: OWNER }).ok).toBe(true);

    handle.runScheduler();
    expect(
      handle.tasks.listReviewItems(rule.id).filter((i) => i.review.headline?.startsWith('New in')),
    ).toEqual([]);
  });
});

describe('the run-output pass on a real store', () => {
  let dataDir: string;
  let repo: string;
  let store: TaskStore;
  const opened = new Set<string>();
  const reports: string[] = [];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'run-output-store-'));
    repo = mkdtempSync(join(tmpdir(), 'run-output-files-'));
    git(repo, 'init', '-q');
    store = new TaskStore({ dataDir, debounceMs: 5 });
    opened.clear();
    reports.length = 0;
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  /** A lister whose cache never outlives a pass: each read is a fresh walk. */
  function schedulerFor(clock: () => number, output = true, through: RunOutputStore = store) {
    let listerNow = 0;
    const lister = createMarkdownLister(() => (listerNow += DAY));
    const { workspaceId, ruleId } = seed(store, {
      rule: { kind: 'every', everyMs: DAY },
      armedAt: MON,
      ...(output ? { output: { folder: 'roundups' } } : {}),
    });
    const scheduler = createTaskScheduler(store, {
      now: clock,
      report: () => {},
      observers: [
        observeRunOutput(
          through,
          {
            files: () => lister(repo).map((f) => ({ relPath: f.relPath, at: f.mtimeMs })),
            opened: (_ws, relPath) => opened.has(relPath),
          },
          SCHEDULER_ACTOR,
          (m) => reports.push(m),
        ),
      ],
    });
    return { workspaceId, ruleId, scheduler };
  }

  /** Close the newest instance as though it ran from `at` for ten minutes. */
  function runAt(workspaceId: string, ruleId: string, at: number, files: string[]) {
    const instance = instancesOf(store, workspaceId, ruleId).at(-1);
    if (!instance) throw new Error('no instance');
    instance.createdAt = at;
    files.forEach((rel, i) => writeAt(repo, rel, at + (i + 1) * MIN));
    store.transition(instance.id, 'done', { actor: OWNER });
    const closing = instance.transitions?.at(-1);
    if (closing) closing.ts = at + 10 * MIN;
  }

  it('replaces an unopened item with the next run’s, carrying what was never opened', () => {
    let now = MON + DAY + MIN;
    const { workspaceId, ruleId, scheduler } = schedulerFor(() => now);
    scheduler.tick();
    runAt(workspaceId, ruleId, MON + DAY, ['roundups/ferry-0303.md', 'clippings/heron.md']);
    now = MON + DAY + 30 * MIN;
    scheduler.tick();
    const [monday] = openOn(store.listReviewItems(ruleId));
    expect(monday?.review.headline).toBe('New in roundups: ferry-0303.md');

    now = MON + 2 * DAY + MIN;
    scheduler.tick();
    runAt(workspaceId, ruleId, MON + 2 * DAY, ['roundups/ferry-0304.md']);
    now = MON + 2 * DAY + 30 * MIN;
    scheduler.tick();
    const open = openOn(store.listReviewItems(ruleId));
    expect(open).toHaveLength(1);
    expect(open[0]?.id).not.toBe(monday?.id);
    expect(open[0]?.review.headline).toBe('New in roundups: ferry-0304.md');
    expect(open[0]?.review.detail).toContain('Not opened yet from earlier runs');
    expect(open[0]?.review.detail).toContain(encodeURIComponent('roundups/ferry-0303.md'));
    expect(store.getTask(ruleId)?.schedule?.state?.output?.item?.paths).toEqual([
      'roundups/ferry-0304.md',
      'roundups/ferry-0303.md',
    ]);
  });

  it('files nothing for a run that wrote nothing in the folder, or for a rule with no folder', () => {
    let now = MON + DAY + MIN;
    const { workspaceId, ruleId, scheduler } = schedulerFor(() => now);
    scheduler.tick();
    runAt(workspaceId, ruleId, MON + DAY, ['clippings/heron.md']);
    now = MON + DAY + 30 * MIN;
    scheduler.tick();
    expect(store.listReviewItems(ruleId)).toHaveLength(0);
    expect(store.getTask(ruleId)?.schedule?.state?.output?.forSuccessAt).toBe(MON + DAY + 10 * MIN);

    const bare = schedulerFor(() => now, false);
    now = MON + DAY + MIN;
    bare.scheduler.tick();
    runAt(bare.workspaceId, bare.ruleId, MON + DAY, ['roundups/ferry-0303.md']);
    now = MON + DAY + 30 * MIN;
    bare.scheduler.tick();
    expect(store.listReviewItems(bare.ruleId)).toHaveLength(0);
  });

  it('waits out the slack after the close before it looks', () => {
    let now = MON + DAY + MIN;
    const { workspaceId, ruleId, scheduler } = schedulerFor(() => now);
    scheduler.tick();
    runAt(workspaceId, ruleId, MON + DAY, ['roundups/ferry-0303.md']);
    now = MON + DAY + 10 * MIN + 30_000;
    scheduler.tick();
    expect(store.listReviewItems(ruleId)).toHaveLength(0);
    now = MON + DAY + 12 * MIN;
    scheduler.tick();
    expect(openOn(store.listReviewItems(ruleId))).toHaveLength(1);
  });

  it('forgets an item a person answered, and the next run carries nothing from it', () => {
    let now = MON + DAY + MIN;
    const { workspaceId, ruleId, scheduler } = schedulerFor(() => now);
    scheduler.tick();
    runAt(workspaceId, ruleId, MON + DAY, ['roundups/ferry-0303.md']);
    now = MON + DAY + 30 * MIN;
    scheduler.tick();
    const [item] = openOn(store.listReviewItems(ruleId));
    if (!item) throw new Error('no item');
    expect(store.answerTaskReview(ruleId, item.id, 'Read it', { actor: PERSON }).ok).toBe(true);
    now = MON + 2 * DAY + MIN;
    scheduler.tick();
    runAt(workspaceId, ruleId, MON + 2 * DAY, ['roundups/ferry-0304.md']);
    now = MON + 2 * DAY + 30 * MIN;
    scheduler.tick();
    const open = openOn(store.listReviewItems(ruleId));
    expect(open).toHaveLength(1);
    expect(open[0]?.review.detail).not.toContain('Not opened yet');
  });

  it('tries a run again on the next tick when the store refused its item', () => {
    let now = MON + DAY + MIN;
    let refusals = 1;
    const refusing: RunOutputStore = {
      getTask: (id) => store.getTask(id),
      listReviewItems: (id) => store.listReviewItems(id),
      addReviewItem: (id, review, opts) =>
        refusals-- > 0
          ? { ok: false, error: 'bad-review', message: 'refused once' }
          : store.addReviewItem(id, review, opts),
      withdrawReviewItem: (id, itemId, opts) => store.withdrawReviewItem(id, itemId, opts),
      scheduleSave: (ws) => store.scheduleSave(ws),
    };
    const { workspaceId, ruleId, scheduler } = schedulerFor(() => now, true, refusing);
    scheduler.tick();
    runAt(workspaceId, ruleId, MON + DAY, ['roundups/ferry-0303.md']);
    now = MON + DAY + 30 * MIN;
    scheduler.tick();
    expect(store.listReviewItems(ruleId)).toHaveLength(0);
    expect(reports.some((m) => m.includes('output item refused'))).toBe(true);
    now += MIN;
    scheduler.tick();
    expect(openOn(store.listReviewItems(ruleId)).map((i) => i.review.headline)).toEqual([
      'New in roundups: ferry-0303.md',
    ]);
  });
});

describe('the item a run files', () => {
  it('is one the store accepts even for a long folder and a file name with a line break', () => {
    const rule = { id: 't-rule', title: 'Write the ferry roundup' } as Parameters<
      typeof buildOutputReview
    >[0]['rule'];
    const folder = `notes/${'tide'.repeat(127)}`;
    const review = buildOutputReview({
      workspaceId: 'w-harbour',
      rule,
      folder,
      paths: [`${folder}/ferry\nroundup.md`],
      fresh: 1,
    });
    expect(checkReviewPayload(review).ok).toBe(true);
    expect(String(review.headline)).toStartWith('New in tidetide');
  });
});
