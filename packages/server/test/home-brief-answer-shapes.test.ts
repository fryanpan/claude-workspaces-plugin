/**
 * What's New says what an answer was, not that every answer was a decision.
 *
 * Every review item's answer writes `decision.answered`, and the brief counted
 * every one of those as a decision — so a credential hand-over of two values
 * read "**Decided:** 2 decisions were answered" when nobody had decided
 * anything. The shape lives on the item; `reviewOf` is how the brief reads it.
 * All fixtures synthetic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AnsweredReview,
  type BriefEventRow,
  buildBriefPrompt,
  deterministicBrief,
} from '../src/home-brief.ts';
import { createServer } from '../src/server.ts';

const NOW = 1_770_000_000_000;

const titles = new Map<string, string>([
  ['t-retry', 'Pick the relay retry policy'],
  ['t-relay', 'Post the nightly index to the Saltmarsh relay'],
  ['t-copy', 'Tighten the launch notes'],
]);

const items = new Map<string, AnsweredReview>([
  ['r-retry', { shape: 'decision' }],
  ['r-relay', { shape: 'secret', secretCount: 2 }],
  ['r-copy', { shape: 'review' }],
]);

const answer = (ts: number, taskId: string, reviewItemId: string, text: string): BriefEventRow => ({
  event: 'decision.answered',
  ts,
  taskId,
  reviewItemId,
  actor: { name: 'Harborlight Reviewer' },
  answer: text,
});

const input = (events: BriefEventRow[], withLookup = true) => ({
  workspaceId: 'ws-1',
  events,
  queue: { total: 0 },
  titleOf: (id: string) => titles.get(id),
  ...(withLookup ? { reviewOf: (_taskId: string, id: string) => items.get(id) } : {}),
});

const decision = answer(NOW + 1, 't-retry', 'r-retry', 'Three retries.');
const handOver = answer(
  NOW + 2,
  't-relay',
  'r-relay',
  'Secrets saved: saltmarsh-relay-account, saltmarsh-relay-signer',
);

describe('a brief built from one decision and one hand-over', () => {
  it('counts the decision as a decision and the hand-over by what it handed over', () => {
    const md = deterministicBrief(input([decision, handOver]));
    expect(md).toContain(
      '**Decided:** 1 decision was answered — [Pick the relay retry policy](/workspaces/ws-1?task=t-retry).',
    );
    expect(md).toContain(
      '**Handed over:** 2 values — [Post the nightly index to the Saltmarsh relay](/workspaces/ws-1?task=t-relay).',
    );
    expect(md).not.toContain('2 decisions');
  });

  it('CONTROL: without the lookup, both read as decisions — the fault as reported', () => {
    const md = deterministicBrief(input([decision, handOver], false));
    expect(md).toContain('**Decided:** 2 decisions were answered');
    expect(md).not.toContain('**Handed over:**');
  });

  it('a hand-over alone decides nothing', () => {
    const md = deterministicBrief(input([handOver]));
    expect(md).not.toContain('**Decided:**');
    expect(md).toContain('**Handed over:** 2 values');
  });

  it('an answered review is a review, not a decision', () => {
    const md = deterministicBrief(input([answer(NOW + 3, 't-copy', 'r-copy', 'Looks right.')]));
    expect(md).not.toContain('**Decided:**');
    expect(md).toContain(
      '**Reviewed:** 1 review was answered — [Tighten the launch notes](/workspaces/ws-1?task=t-copy).',
    );
  });

  it('a legacy answer, which carries no review item, stays a decision', () => {
    const legacy: BriefEventRow = { event: 'decision.answered', ts: NOW + 4, taskId: 't-retry' };
    expect(deterministicBrief(input([legacy]))).toContain('**Decided:** 1 decision was answered');
  });

  it('the digest the model reads names the hand-over for what it was', () => {
    const { user } = buildBriefPrompt(input([decision, handOver]), 'x', {
      from: NOW,
      capped: false,
      shown: 0,
      total: 0,
    });
    const lines = user.split('\n');
    expect(lines.filter((l) => l.includes('decision.answered'))).toHaveLength(1);
    expect(lines.find((l) => l.includes('t-relay'))).toContain('secret.handed_over');
  });
});

describe('the Home route reads what each answered item asked', () => {
  // The brief above is pure; this is the wiring that hands it the lookup. A
  // hand-over made through the real secrets door, then read back off Home.
  const AGENT = { id: 'agent-riverbend', name: 'Riverbend Bot', kind: 'known', color: '#888888' };
  let dataDir: string;
  let handle: ReturnType<typeof createServer>;
  let local: (path: string, body?: unknown) => Promise<Response>;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'home-brief-shapes-'));
    handle = createServer({ port: 0, dataDir, secretWriter: async () => ({ ok: true }) });
    local = (path, body) =>
      fetch(`http://127.0.0.1:${handle.port}${path}`, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      });
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a hand-over through the secrets door reads as handed over on Home', async () => {
    const json = async <T>(res: Response): Promise<T> => {
      expect(res.status).toBe(200);
      return (await res.json()) as T;
    };
    const ws = (
      await json<{ workspace: { id: string } }>(
        await local('/workspaces', { name: 'Harborlight relay' }),
      )
    ).workspace.id;
    const task = (
      await json<{ task: { id: string } }>(
        await local(`/workspaces/${ws}/tasks`, {
          title: 'Post the nightly index to the Saltmarsh relay',
          body: 'Agent can post to the relay so that the index stays fresh.',
          author: AGENT,
        }),
      )
    ).task.id;
    const secrets = [
      { label: 'Relay account name', service: 'saltmarsh-relay-account' },
      { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
    ];
    const item = (
      await json<{ item: { id: string } }>(
        await local(`/workspaces/${ws}/tasks/${task}/review-items`, {
          review: {
            shape: 'secret',
            headline: 'Paste the two relay values so the nightly post can run',
            detail: 'The nightly pass signs in to the relay and cannot without these two values.',
            secrets,
          },
          author: AGENT,
        }),
      )
    ).item.id;
    await json(
      await local(`/workspaces/${ws}/tasks/${task}/review-items/${item}/secrets`, {
        author: { id: 'known-riley', name: 'Riley', kind: 'known', color: '#2e7dd7' },
        secrets: secrets.map((s) => ({ service: s.service, value: 'not-a-real-value' })),
      }),
    );
    const home = await json<{ brief: { markdown: string } }>(
      await local(`/workspaces/${ws}/home?user=Riley&format=json`),
    );
    expect(home.brief.markdown).toContain('**Handed over:** 2 values');
    expect(home.brief.markdown).not.toContain('**Decided:**');
  });
});
