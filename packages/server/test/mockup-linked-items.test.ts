/**
 * A mock's page carries the TICKET review items that link it, so its dock can
 * answer them in place — and carries nothing for a page no open item links,
 * or for a share visitor.
 *
 * Two halves. The link rule is pure (`itemLinkedDocIds`, `linkedTaskItems`)
 * and is driven over fixtures. The serve is driven through the real route
 * table: file a ticket item, open the mock, read the data block the widget
 * reads out of the HTML the browser received.
 *
 * Fixtures are fictional — a lemonade stand's price board.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload, TaskReviewItem } from '@claude-workspaces/core';
import type { Ref } from '@claude-workspaces/core/task-wire';
import { itemLinkedDocIds, linkedItemsEmbed, linkedTaskItems } from '../src/mockup-linked-items.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';

const T0 = 1_700_000_000_000;

function item(
  over: Partial<Omit<TaskReviewItem, 'review'>> & { review?: Partial<ReviewPayload> } = {},
) {
  const { review, ...rest } = over;
  return {
    id: 'r-price',
    createdAt: T0,
    createdBy: 'Cartographer',
    ...rest,
    review: { shape: 'review', headline: 'Is the price board readable?', ...review },
  } as TaskReviewItem;
}

describe('which docs a ticket item links', () => {
  it('reads a mock link and a doc link out of the detail, relative or absolute', () => {
    const detail =
      'See [the board](/workspaces/w-stand/mockups/d-board) and ' +
      'https://stand.example/workspaces/w-stand/docs/d-plan.';
    expect(itemLinkedDocIds(detail, [])).toEqual(['d-board', 'd-plan']);
  });

  it("falls back to the task's links only when the detail names no page", () => {
    const links: Ref[] = [
      { kind: 'doc', docId: 'd-linked' },
      { kind: 'url', url: '/workspaces/w-stand/mockups/d-by-url' },
    ];
    expect(itemLinkedDocIds('Is the price right?', links)).toEqual(['d-linked', 'd-by-url']);
    // CONTROL: the same task, but an ask that names a page is about THAT page
    // — the task's other links do not pull it onto them.
    expect(itemLinkedDocIds('Look at /workspaces/w-stand/mockups/d-board', links)).toEqual([
      'd-board',
    ]);
  });
});

describe('the ticket items a mock page carries', () => {
  const task = (reviews: TaskReviewItem[], over: Record<string, unknown> = {}) => ({
    task: { id: 't-stand', title: 'Price board', status: 'todo' as const, links: [], ...over },
    reviews,
  });
  const run = (docId: string, rows: Array<ReturnType<typeof task>>) =>
    linkedTaskItems({
      docId,
      tasks: rows.map((r) => r.task),
      reviewsOf: (id) => rows.find((r) => r.task.id === id)?.reviews ?? [],
      canonical: (id) => (id === 'd-alias' ? 'd-board' : id),
    });
  const linking = (docId: string) => ({ detail: `See /workspaces/w-stand/mockups/${docId}` });

  it('carries an open item that links the page, and not one linking another page', () => {
    const rows = [task([item({ review: linking('d-board') })])];
    const got = run('d-board', rows);
    expect(got.map((i) => [i.taskId, i.reviewItemId, i.by])).toEqual([
      ['t-stand', 'r-price', 'Cartographer'],
    ]);
    expect(run('d-elsewhere', rows)).toEqual([]);
  });

  it('follows an alias to the doc it names', () => {
    expect(run('d-board', [task([item({ review: linking('d-alias') })])])).toHaveLength(1);
  });

  it('leaves out answered, held, withdrawn and owner-only items, and done tickets', () => {
    const answered = item({
      answer: { text: 'Readable.', by: 'Reviewer', ts: T0 + 1 },
      review: linking('d-board'),
    });
    const held = item({
      review: { ...linking('d-board') },
      judge: { at: T0, verdict: 'held', reason: 'no stakes' },
    });
    const withdrawn = item({
      review: { ...linking('d-board'), withdrawnAt: T0, withdrawnBy: 'Cartographer' },
    });
    const ownerOnly = item({ review: { ...linking('d-board'), ownerOnly: true } });
    for (const excluded of [answered, held, withdrawn, ownerOnly]) {
      expect(run('d-board', [task([excluded])])).toEqual([]);
    }
    expect(
      run('d-board', [task([item({ review: linking('d-board') })], { status: 'done' })]),
    ).toEqual([]);
    // CONTROL: the fixture every exclusion above starts from is carried, so
    // each empty list is about its own flag.
    expect(run('d-board', [task([item({ review: linking('d-board') })])])).toHaveLength(1);
  });

  it('writes no block for no items, and escapes a headline that tries to close it', () => {
    expect(linkedItemsEmbed([])).toBe('');
    const embed = linkedItemsEmbed([
      {
        taskId: 't-stand',
        reviewItemId: 'r-price',
        review: { shape: 'review', headline: '</script><b>bold</b>' },
        by: 'Cartographer',
        ts: T0,
      },
    ]);
    expect(embed.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe('serving a mock', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let access: AccessHarness;
  let ws = '';
  let taskId = '';
  let linkedMock = '';
  let unlinkedMock = '';

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify(body),
    });
    expect(res.ok, `${path} ${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const AGENT = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
  const bindMock = async (name: string) => {
    const file = join(dataDir, `${name}.html`);
    writeFileSync(file, `<!doctype html><html><body><h1>${name}</h1></body></html>`);
    const doc = (await post(`/workspaces/${ws}/docs`, {
      docId: name,
      type: 'mockup',
      sourceUrl: file,
    })) as { docId: string };
    await post(`/workspaces/${ws}/docs:attach`, { docId: doc.docId });
    return doc.docId;
  };
  const block = (html: string): Array<{ reviewItemId: string; taskId: string }> | null => {
    const m = html.match(/<script type="application\/json" data-cw-linked-items>([^<]*)<\/script>/);
    return m ? JSON.parse(m[1] ?? '[]') : null;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mockup-linked-items-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    ws = (
      (await post('/workspaces', { name: 'Lemonade stand', author: AGENT })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    linkedMock = await bindMock('price-board');
    unlinkedMock = await bindMock('menu-card');
    taskId = (
      (await post(`/workspaces/${ws}/tasks`, {
        title: 'Price board',
        assignee: 'Cartographer',
        author: AGENT,
      })) as { task: { id: string } }
    ).task.id;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('hands the dock the ticket item linking this mock, and nothing to a mock it does not link', async () => {
    const filed = (await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: AGENT,
      review: {
        shape: 'review',
        headline: 'Is the price board readable from the street?',
        detail: `Check [the board](/workspaces/${ws}/mockups/${linkedMock}) at phone width.`,
      },
    })) as { item: { id: string }; held?: boolean };
    if (filed.held) {
      await post(`/workspaces/${ws}/tasks/${taskId}/review-items/${filed.item.id}/release`, {
        author: { id: 'person:reviewer', name: 'Reviewer', kind: 'person' },
      });
    }
    const local = (docId: string) =>
      fetch(`${base}/workspaces/${ws}/mockups/${docId}`, {
        headers: { host: `localhost:${handle.port}` },
      }).then((r) => r.text());

    expect(block(await local(linkedMock))).toEqual([
      expect.objectContaining({ taskId, reviewItemId: filed.item.id }),
    ]);
    // A page no open item links carries no block at all — so no dock.
    expect(block(await local(unlinkedMock))).toBeNull();

    // A share visitor on the same board is served the same mock WITHOUT it:
    // the dock shows a visitor only the mock's own thread asks.
    const share = await mintAccessShare(base, access, ws);
    const visitorRes = await fetch(`${base}/workspaces/${ws}/mockups/${linkedMock}`, {
      headers: { host: share.host, 'cf-access-jwt-assertion': share.jwt },
    });
    const visitorHtml = await visitorRes.text();
    // CONTROL: the visitor really was served the mock, so the missing block
    // is about who asked and not about a refusal.
    expect(visitorRes.status).toBe(200);
    expect(visitorHtml).toContain('<h1>price-board</h1>');
    expect(block(visitorHtml)).toBeNull();

    // Answered, it leaves the page on the next load.
    await post(`/workspaces/${ws}/tasks/${taskId}/review-items/${filed.item.id}/answer`, {
      author: { id: 'person:reviewer', name: 'Reviewer', kind: 'person' },
      text: 'Readable.',
    });
    expect(block(await local(linkedMock))).toBeNull();
  });
});
