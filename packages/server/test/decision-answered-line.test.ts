/**
 * The `decision.answered` channel line, fed the rows the SERVER actually
 * writes rather than hand-written fixtures.
 *
 * Same lesson as `activity-lines.test.ts`: a renderer test that invents its
 * own payload proves the switch has a case for the event, never that the keys
 * it reads are the keys the store emits. The clause under test here is about
 * one of those keys — `links` — so a fixture would be exactly the wrong
 * evidence.
 *
 * `events.jsonl` is the read-back surface because `appendAudit` writes the
 * SSE payload byte-for-byte (`event` key, not `type`), so the row the log
 * holds is the frame the plugin's renderer receives.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import { type DecisionAnsweredPayload, decisionAnsweredLine } from '../../mcp/src/decision-line.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type Task, eventsLogPath } from '../src/tasks.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON: User = { id: 'known-alex', name: 'Alex', kind: 'known', color: '#2e7dd7' };
const AGENT: User = {
  id: 'agent-index-rebuild',
  name: 'Index Rebuild',
  kind: 'known',
  color: '#888888',
};

const CLAUSE = 'walk its links as the propagation checklist';

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('the decision.answered channel line only sends a reader to links that exist', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** The last `decision.answered` row the server wrote to the log. */
  const lastAnsweredRow = (): DecisionAnsweredPayload => {
    const path = eventsLogPath(dataDir, wsId);
    expect(existsSync(path), 'no events log — nothing was recorded').toBe(true);
    const rows = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { event: string } & DecisionAnsweredPayload)
      .filter((r) => r.event === 'decision.answered');
    const row = rows.at(-1);
    // A row that never reached the log would render nothing, which makes
    // every assertion below vacuous.
    expect(row, 'no decision.answered row in the log').toBeDefined();
    return row as DecisionAnsweredPayload;
  };
  /** The line an attached agent would see for the last answer recorded. */
  const lastAnsweredLine = (): string => decisionAnsweredLine(lastAnsweredRow());

  /** Answer a fresh decision task carrying `links`, and render its row. */
  const answerDecisionWith = async (links: unknown[]): Promise<string> => {
    const created = await post(`/workspaces/${wsId}/tasks`, {
      title: 'Rebuild the index now or after the freeze?',
      assignee: 'human',
      needs: 'decision',
      body: 'Now or after the freeze? Now costs a night of downtime; after the freeze slips the search work a week. Blocked until answered: the query-latency fix.',
      links,
      author: AGENT,
    });
    expect(created.status).toBe(200);
    const task = ((await created.json()) as { task: Task }).task;
    const answered = await post(`/workspaces/${WS}/tasks/${task.id}/answer`, {
      text: 'Rebuild after the freeze.',
      author: PERSON,
    });
    expect(answered.status).toBe(200);
    return lastAnsweredLine();
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'decision-answered-line-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    const ws = await post('/workspaces', { name: 'index-rebuild' });
    wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    WS = wsId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('offers the checklist when the task has links to walk', async () => {
    const line = await answerDecisionWith([{ kind: 'doc', docId: 'search-plan' }]);
    // Positive control: the line renders at all, with the actor and the
    // verbatim answer that are the point of the row.
    expect(line).toContain('[decision.answered]');
    expect(line).toContain('Alex');
    expect(line).toContain('Rebuild after the freeze.');
    expect(line).toContain(CLAUSE);
  });

  it('omits the checklist when the task has no links', async () => {
    const line = await answerDecisionWith([]);
    // Same positive control, so "no clause" cannot be "no line".
    expect(line).toContain('[decision.answered]');
    expect(line).toContain('Alex');
    expect(line).toContain('Rebuild after the freeze.');
    expect(line).not.toContain(CLAUSE);
    // …and nothing is left dangling where the clause used to sit.
    expect(line.trimEnd()).toBe(line);
    expect(line).not.toMatch(/—\s*$/);
  });

  it('names what was asked beside the answer, so a bare option label is not orphaned', async () => {
    // The case the lead hit: a review ITEM on a row, whose headline is not
    // the row's title, answered with an option label. The frame has to say
    // which question "You merge it" answers without a lookup.
    const created = await post(`/workspaces/${wsId}/tasks`, {
      title: 'Land the search work',
      assignee: 'human',
      body: 'Two candidate merges are staged behind this row.',
      author: AGENT,
    });
    expect(created.status).toBe(200);
    const task = ((await created.json()) as { task: Task }).task;
    const filed = await post(`/workspaces/${WS}/tasks/${task.id}/review-items`, {
      review: {
        review_type: 'decision',
        headline: 'Which merge goes first — the index PR or the ranking PR?',
        detail: 'Both are green. The index PR is larger; the ranking PR depends on nothing.',
        options: [
          { id: 'index', label: 'Index first' },
          { id: 'ranking', label: 'You merge it' },
        ],
      },
      author: AGENT,
    });
    expect(filed.status).toBe(200);
    const item = ((await filed.json()) as { item: { id: string } }).item;
    const answered = await post(
      `/workspaces/${WS}/tasks/${task.id}/review-items/${item.id}/answer`,
      {
        text: 'You merge it',
        answeredWith: 'ranking',
        author: PERSON,
      },
    );
    expect(answered.status).toBe(200);
    const row = lastAnsweredRow();
    // The payload itself carries the question — a consumer that never
    // fetches the task can still say what was asked and what was chosen.
    expect(row.headline).toBe('Which merge goes first — the index PR or the ranking PR?');
    expect(row.answer).toBe('You merge it');
    const line = decisionAnsweredLine(row);
    expect(line).toContain('"You merge it"');
    expect(line).toContain('Which merge goes first');
    // The legacy path — a decision ROW, whose title is the question — says so too.
    const legacy = await answerDecisionWith([]);
    expect(legacy).toContain('Rebuild the index now or after the freeze?');
    expect(lastAnsweredRow().headline).toBe('Rebuild the index now or after the freeze?');
  });
});
