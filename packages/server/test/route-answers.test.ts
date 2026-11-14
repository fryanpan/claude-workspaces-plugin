/**
 * What answers every address in the route table, recorded and held.
 *
 * Milestone M12 moves route families one at a time from the ordered chain
 * (`routes/request-chain.ts`) into the Hono app (`routes/hono-front.ts`). A
 * move is correct when nothing a caller can see changes. This file is that
 * check: it drives one real request per (pattern, method) row of
 * `ROUTE_TABLE` through a running server and compares each answer with
 * `fixtures/route-answers.json`, which was generated from the same requests
 * before any family moved.
 *
 * AN ANSWER is the status, the media type, the `error` code of a JSON body,
 * the sorted top-level keys of a JSON object body (`[]` for an array), the
 * `cache-control` and `location` headers, whether a cookie is set, and the
 * HANDLER: the module and function that answered, read by
 * `route-handler-spy.ts` without any hook in production code (`chain` when
 * the chain answered inline, e.g. its final 404). Ids are replaced by their
 * parameter names, and text and timestamps are left out, so the record is
 * the same on every run. So a route answered by a different family, by
 * Hono's own 404 or 405, or by a gate that moved, changes the record even
 * when the body looks the same.
 *
 * EVERY GET ROW IS ALSO PROBED WITH HEAD. Hono answers a HEAD from a GET
 * handler by itself, so a family that moves would start answering HEAD where
 * the chain may have done something else.
 *
 * THE STATE each request meets. `:ws`, `:taskId` and `:docId` are a real
 * board, a task on it and a doc filed on it, so most rows reach their own
 * handler rather than the workspace scope's 404. Every other parameter is
 * `exampleFor`'s stand-in, which names nothing. Reads share one seed. Every
 * write (POST, PUT, DELETE) gets a board, task and doc of its own, so an
 * archive or a delete earlier in the table cannot change a later answer and
 * adding a row cannot shift the rows after it.
 *
 * REGENERATING: `CW_UPDATE_ROUTE_ANSWERS=1 bun test test/route-answers.test.ts`
 * rewrites the fixture. Do it when a row is added or removed, and read the
 * diff: any change to an existing row's answer is the thing this file exists
 * to catch, and needs its own reason in the PR body.
 *
 * Fake deployer and refresher (as `route-table-loopback.test.ts`): nothing
 * here may pull, restart or update a plugin cache.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Deployer } from '../src/deploy.ts';
import { PluginRefresher } from '../src/plugin-refresh.ts';
import { ROUTE_TABLE } from '../src/routes/route-table-rows.ts';
import { exampleFor } from '../src/routes/route-table.ts';
import type { ServerHandle } from '../src/server.ts';
import { type RouteHandlerSpy, spyOnRouteHandlers } from './route-handler-spy.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'route-answers.json');
const UPDATE = process.env.CW_UPDATE_ROUTE_ANSWERS === '1';
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Seeds built at once; small enough not to flood a loaded runner. */
const SEED_BATCH = 16;

interface Seed {
  ws: string;
  taskId: string;
  docId: string;
}

/** One request's answer, as one comparable line. */
async function answerOf(
  res: Response,
  method: string,
  normalize: (s: string) => string,
  handler: string,
): Promise<string> {
  const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() || '-';
  const parts = [String(res.status), type];
  // A stream answers 200 and never ends, and HEAD has no body: read neither.
  if (type === 'application/json' && method !== 'HEAD') {
    const body = (await res.json().catch(() => undefined)) as unknown;
    if (Array.isArray(body)) parts.push('[]');
    else if (body && typeof body === 'object') {
      const error = (body as { error?: unknown }).error;
      if (typeof error === 'string') parts.push(`error=${error}`);
      parts.push(`{${Object.keys(body).sort().join(',')}}`);
    }
  } else {
    await res.body?.cancel();
  }
  const cache = res.headers.get('cache-control');
  if (cache) parts.push(`cache=${cache}`);
  const location = res.headers.get('location');
  if (location) parts.push(`location=${normalize(location)}`);
  if (res.headers.has('set-cookie')) parts.push('set-cookie');
  return `${parts.join(' ')} | by ${handler}`;
}

/** The row's pattern with the seed's ids where it names one. */
function addressFor(pattern: string, seed: Seed): string {
  const real: Record<string, string> = {
    ':ws': seed.ws,
    ':taskId': seed.taskId,
    ':docId': encodeURIComponent(seed.docId),
  };
  return exampleFor(pattern)
    .split('/')
    .map((seg, i) => real[pattern.split('/')[i] ?? ''] ?? seg)
    .join('/');
}

describe('every route-table row is answered as recorded', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let seeds = 0;
  let spy: RouteHandlerSpy;
  const answers = new Map<string, string>();

  const seed = async (): Promise<Seed> => {
    seeds += 1;
    const ws = handle.tasks.createWorkspace(`Riverbend ${seeds}`).id;
    const filed = handle.tasks.createTask(ws, {
      title: 'Harborlight survey',
      assignee: 'human',
      actor: { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' },
    });
    if (!filed.ok) throw new Error('seed: task create refused');
    const file = join(dataDir, `saltmarsh-${seeds}.md`);
    writeFileSync(file, '# Saltmarsh\n\nBody.\n');
    const res = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: `saltmarsh-${seeds}`, sourceUrl: file }),
    });
    if (res.status !== 200) throw new Error(`seed: doc create → ${res.status}`);
    const { docId } = (await res.json()) as { docId: string };
    return { ws, taskId: filed.task.id, docId };
  };

  beforeAll(async () => {
    // The spy replaces the route modules, so the server is imported after it.
    spy = await spyOnRouteHandlers();
    const { createServer } = await import('../src/server.ts');
    dataDir = mkdtempSync(join(tmpdir(), 'route-answers-'));
    handle = createServer({
      port: 0,
      dataDir,
      identifyAgentCaller: async () => ({ ok: true, agentId: 'a-1', via: 'session' }),
      deployer: new Deployer({
        run: async () => ({
          ok: true,
          status: 'deployed',
          changed: false,
          before: 'aaaaaaa',
          after: 'aaaaaaa',
          behind: 0,
          ahead: 0,
          message: 'fixture deploy',
          ranAt: 1,
          restartRequested: false,
        }),
        now: () => 1,
      }),
      pluginRefresher: new PluginRefresher({
        run: async () => ({
          ok: true,
          before: '0.0.1',
          after: '0.0.1',
          changed: false,
          message: 'fixture refresh',
          ranAt: 1,
        }),
        minIntervalMs: 0,
      }),
    });
    base = `http://127.0.0.1:${handle.port}`;

    const shared = await seed();
    // Every row's own methods, plus a HEAD beside every GET: Hono answers a
    // HEAD from a GET handler by itself, so a family that moves would start
    // answering HEAD where the chain did something else.
    const rows = ROUTE_TABLE.flatMap((e) => {
      const methods =
        e.methods.includes('GET') && !e.methods.includes('HEAD')
          ? [...e.methods, 'HEAD']
          : e.methods;
      return methods.map((method) => ({ e, method }));
    });
    // Reads first, against one seed; then each write against a seed of its own.
    const ordered = [
      ...rows.filter((r) => READS.has(r.method)),
      ...rows.filter((r) => !READS.has(r.method)),
    ];
    // Every write's seed is built before any recorded request, in bounded
    // parallel batches: seeding is about half the work, and the spy only
    // attributes one request at a time, so the recorded requests themselves
    // stay sequential.
    const writes = ordered.filter((r) => !READS.has(r.method)).length;
    const own: Seed[] = [];
    for (let i = 0; i < writes; i += SEED_BATCH) {
      const batch = Math.min(SEED_BATCH, writes - i);
      own.push(...(await Promise.all(Array.from({ length: batch }, () => seed()))));
    }
    let nextOwn = 0;
    for (const { e, method } of ordered) {
      const key = `${method} ${e.pattern}`;
      if (answers.has(key)) continue;
      const at = READS.has(method) ? shared : own[nextOwn++];
      if (!at) throw new Error(`no seed left for ${key}`);
      const hasBody = !READS.has(method);
      spy.begin();
      const res = await fetch(`${base}${addressFor(e.pattern, at)}`, {
        method,
        redirect: 'manual',
        headers: hasBody ? { 'content-type': 'application/json' } : {},
        ...(hasBody ? { body: '{}' } : {}),
      });
      const normalize = (text: string) =>
        text
          .replaceAll(base, '<base>')
          .replaceAll(at.ws, ':ws')
          .replaceAll(at.taskId, ':taskId')
          .replaceAll(encodeURIComponent(at.docId), ':docId')
          .replaceAll(at.docId, ':docId');
      answers.set(key, await answerOf(res, method, normalize, spy.answeredBy()));
    }
    if (UPDATE) {
      const sorted = Object.fromEntries([...answers].sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(FIXTURE, `${JSON.stringify(sorted, null, 2)}\n`);
    }
    // About 670 requests and 300 seeds. Locally this hook takes 0.4-0.5s; on
    // a loaded CI shard it overran bun's 5s hook default (main at ebbc4422b).
    // The bound is a ceiling for a starved runner, not a measurement.
  }, 60_000);

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('records an answer for every (pattern, method) in the table, and no other', () => {
    const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
    expect(Object.keys(recorded).sort()).toEqual([...answers.keys()].sort());
  });

  it('answers each one exactly as recorded', () => {
    const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
    const changed = [...answers]
      .filter(([key, got]) => key in recorded && recorded[key] !== got)
      .map(([key, got]) => `${key}: recorded "${recorded[key]}", now "${got}"`);
    expect(changed).toEqual([]);
  });

  it('reaches handlers past the workspace scope (positive control)', () => {
    // If the seed stopped working, every board row would read the scope's 404
    // and the snapshot would hold nothing about the handlers behind it.
    expect(answers.get('GET /workspaces/:ws/tasks/:taskId/detail')).toStartWith('200 ');
    expect(answers.get('GET /workspaces/:ws/docs/:docId/content')).toStartWith('200 ');
  });

  it('names the module behind each answer (positive control for the spy)', () => {
    // If the spy stopped seeing the route modules, every row would read
    // `by chain` and the handler column would hold nothing.
    expect(answers.get('GET /workspaces/:ws/tasks/:taskId/detail')).toContain('| by tasks.ts:');
    expect(answers.get('POST /recall/status')).toContain('| by recall-webhook.ts:');
    const handlers = new Set([...answers.values()].map((a) => a.split(' | by ')[1]));
    expect(handlers.size).toBeGreaterThan(40);
  });
});
