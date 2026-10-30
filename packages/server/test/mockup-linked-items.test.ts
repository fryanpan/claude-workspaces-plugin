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
import { signedInPerson } from './signed-in-person.ts';

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

  describe('an owner-only item', () => {
    const ownerOnly = (over: Partial<ReviewPayload> = {}) =>
      item({ review: { ...linking('d-board'), ownerOnly: true, ...over } });
    const asOwner = (
      rows: Array<ReturnType<typeof task>>,
      page: 'doc' | 'mock',
      docId = 'd-board',
    ) =>
      linkedTaskItems({
        docId,
        tasks: rows.map((r) => r.task),
        reviewsOf: (id) => rows.find((r) => r.task.id === id)?.reviews ?? [],
        canonical: (id) => id,
        owner: true,
        ownerAnswersHere: page === 'doc',
        answerAt: (taskId) => `/workspaces/w-stand?task=${taskId}`,
      });

    it('goes to the owner alone, answered in place on the doc page', () => {
      expect(run('d-board', [task([ownerOnly()])])).toEqual([]);
      const got = asOwner([task([ownerOnly()])], 'doc');
      expect(got).toHaveLength(1);
      expect(got[0]?.answerAt).toBeUndefined();
    });

    it('is answered on the board from a mock, whose scripts must not answer it', () => {
      const [onMock] = asOwner([task([ownerOnly()])], 'mock');
      expect(onMock?.answerAt).toBe('/workspaces/w-stand?task=t-stand');
      // The ask's words end with the link there, which the dock renders.
      expect(onMock?.review.detail).toMatch(
        /\n\n\[Answer on the board\]\(\/workspaces\/w-stand\?task=t-stand\)$/,
      );
      // Without a board link to send it to, a mock leaves it off.
      const bare = linkedTaskItems({
        docId: 'd-board',
        tasks: [task([ownerOnly()]).task],
        reviewsOf: () => [ownerOnly()],
        canonical: (id) => id,
        owner: true,
      });
      expect(bare).toEqual([]);
    });

    it('is answered on the board when its answer has a door of its own', () => {
      const access = item({
        review: { ...linking('d-board'), shape: 'decision', ownerOnly: true },
        access: { op: 'add-audience', workspaceId: 'w-stand', entries: ['ops@example.com'] },
      });
      expect(asOwner([task([access])], 'doc')[0]?.answerAt).toBe(
        '/workspaces/w-stand?task=t-stand',
      );
      expect(asOwner([task([ownerOnly({ shape: 'secret' })])], 'doc')[0]?.answerAt).toBeDefined();
    });

    it('docks a proposed share link on the doc it opens on', () => {
      const link = item({
        review: { shape: 'decision', headline: 'Mints a link.', detail: 'Why.', ownerOnly: true },
        access: {
          op: 'share-link',
          workspaceId: 'w-stand',
          entries: [],
          link: { landing: { kind: 'doc', id: 'd-notes' } },
        },
      });
      expect(asOwner([task([link])], 'doc', 'd-notes')).toHaveLength(1);
      expect(asOwner([task([link])], 'doc', 'd-board')).toEqual([]);
    });
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
  /** The reviewer, signed in on the board page: set in `beforeAll`. */
  let REVIEWER: { id: string; name: string } = { id: '', name: 'Reviewer' };
  let REVIEWER_PROOF: Record<string, string> = {};

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: `localhost:${handle.port}`,
        ...((body as { author?: { id?: string } }).author?.id === REVIEWER.id
          ? REVIEWER_PROOF
          : {}),
      },
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
    const reviewer = signedInPerson(handle, dataDir, `localhost:${handle.port}`, {
      email: 'reviewer@harborlight.example',
      name: 'Reviewer',
    });
    REVIEWER = reviewer.user;
    REVIEWER_PROOF = reviewer.headers;
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
        author: REVIEWER,
      });
    }
    const local = (docId: string) =>
      fetch(`${base}/workspaces/${ws}/mockups/${docId}?cw-frame=1`, {
        headers: { host: `localhost:${handle.port}` },
      }).then((r) => r.text());

    expect(block(await local(linkedMock))).toEqual([
      expect.objectContaining({ taskId, reviewItemId: filed.item.id }),
    ]);
    // A page no open item links carries no block at all — so no dock.
    expect(block(await local(unlinkedMock))).toBeNull();

    // A share visitor on the same board is served the same mock WITHOUT it:
    // the dock shows a visitor only the mock's own thread asks.
    const share = await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, ws);
    const visitorRes = await fetch(`${base}/workspaces/${ws}/mockups/${linkedMock}?cw-frame=1`, {
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
      author: REVIEWER,
      text: 'Readable.',
    });
    expect(block(await local(linkedMock))).toBeNull();
  });

  it('hands the owner an owner-only item linking this mock, to answer on the board', async () => {
    const filed = (await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      author: AGENT,
      review: {
        shape: 'decision',
        headline: 'Publish the menu card to the street?',
        detail: `See [the menu](/workspaces/${ws}/mockups/${unlinkedMock}).`,
        options: [
          { id: 'o-yes', label: 'Publish' },
          { id: 'o-no', label: 'Hold it' },
        ],
        ownerOnly: true,
      },
    })) as { item: { id: string }; held?: boolean };
    if (filed.held) {
      await post(`/workspaces/${ws}/tasks/${taskId}/review-items/${filed.item.id}/release`, {
        author: REVIEWER,
      });
    }
    // The machine's owner, on loopback.
    const owner = await fetch(`${base}/workspaces/${ws}/mockups/${unlinkedMock}?cw-frame=1`, {
      headers: { host: `localhost:${handle.port}` },
    }).then((r) => r.text());
    expect(block(owner)).toEqual([
      expect.objectContaining({
        reviewItemId: filed.item.id,
        answerAt: `/workspaces/${ws}?task=${taskId}`,
      }),
    ]);
    // A share visitor is served the same mock without it.
    const share = await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, ws);
    const visitor = await fetch(`${base}/workspaces/${ws}/mockups/${unlinkedMock}?cw-frame=1`, {
      headers: { host: share.host, 'cf-access-jwt-assertion': share.jwt },
    });
    expect(visitor.status).toBe(200);
    expect(block(await visitor.text())).toBeNull();
  });

  it("never puts an owner-only item in a mock's relay, and refuses one relayed anyway", async () => {
    const mock = await bindMock('tide-chart');
    const file = async (headline: string, ownerOnly: boolean) => {
      const filed = (await post(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
        author: AGENT,
        review: {
          shape: 'decision',
          headline,
          detail: `See [the chart](/workspaces/${ws}/mockups/${mock}).`,
          options: [
            { id: 'o-yes', label: 'Yes' },
            { id: 'o-no', label: 'No' },
          ],
          ...(ownerOnly ? { ownerOnly: true } : {}),
        },
      })) as { item: { id: string }; held?: boolean };
      if (filed.held) {
        await post(`/workspaces/${ws}/tasks/${taskId}/review-items/${filed.item.id}/release`, {
          author: REVIEWER,
        });
      }
      return filed.item.id;
    };
    const plain = await file('Is the low tide line readable?', false);
    const gated = await file('Publish the tide chart to the harbour office?', true);

    // The host page the owner is served: the frame's relay scope is its
    // data-items, written by the server. The plain item is in it, so the
    // check below is about the flag and not about an empty list.
    const host = await fetch(`${base}/workspaces/${ws}/mockups/${mock}`, {
      headers: { host: `localhost:${handle.port}`, accept: 'text/html' },
    }).then((r) => r.text());
    const attr = host.match(/data-items="([^"]*)"/)?.[1] ?? '';
    const scope = JSON.parse(attr.replace(/&quot;/g, '"')) as Array<[string, string]>;
    expect(scope).toContainEqual([taskId, plain]);
    expect(scope.some(([, id]) => id === gated)).toBe(false);

    // Relayed out of the frame anyway, the owner's own answer is refused.
    const answer = (id: string, relayed: boolean) =>
      fetch(`${base}/workspaces/${ws}/tasks/${taskId}/review-items/${id}/answer`, {
        method: 'POST',
        headers: {
          host: `localhost:${handle.port}`,
          'content-type': 'application/json',
          ...REVIEWER_PROOF,
          ...(relayed ? { 'x-cw-via': 'mock-frame' } : {}),
        },
        body: JSON.stringify({ author: REVIEWER, text: 'Yes', answeredWith: 'o-yes' }),
      });
    const refused = await answer(gated, true);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message?: string }).message).toBe(
      'Answer this on the board, not from a mock.',
    );
    // CONTROLS: the same answer from the board lands, and so does a relayed
    // answer to the plain item.
    expect((await answer(plain, true)).status).toBe(200);
    expect((await answer(gated, false)).status).toBe(200);
  });

  it("refuses an owner-only ask on the mock's own doc thread answered from inside the mock", async () => {
    const mock = await bindMock('harbour-map');
    const ask = async (headline: string, ownerOnly: boolean) => {
      const made = (await post(`/workspaces/${ws}/docs/${mock}/threads`, {
        author: AGENT,
        text: headline,
        anchor: { kind: 'subject' },
        review: {
          shape: 'decision',
          headline,
          detail: 'The map goes on the harbour office wall.',
          options: [
            { id: 'o-yes', label: 'Yes' },
            { id: 'o-no', label: 'No' },
          ],
          ...(ownerOnly ? { ownerOnly: true } : {}),
        },
      })) as { thread: { id: string; comments: Array<{ id: string }> } };
      return { threadId: made.thread.id, commentId: made.thread.comments[0]?.id ?? '' };
    };
    const plain = await ask('Is the north pier labelled?', false);
    const gated = await ask('Send the map to the harbour office?', true);
    const answer = (t: { threadId: string; commentId: string }, relayed: boolean) =>
      fetch(`${base}/workspaces/${ws}/docs/${mock}/threads/${t.threadId}/answer`, {
        method: 'POST',
        headers: {
          host: `localhost:${handle.port}`,
          'content-type': 'application/json',
          ...REVIEWER_PROOF,
          ...(relayed ? { 'x-cw-via': 'mock-frame' } : {}),
        },
        body: JSON.stringify({
          author: REVIEWER,
          text: 'Yes',
          optionId: 'o-yes',
          commentId: t.commentId,
        }),
      });
    const refused = await answer(gated, true);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message?: string }).message).toBe(
      'Answer this on the board, not from a mock.',
    );
    // CONTROLS: a relayed answer to the plain ask lands, and so does the
    // owner-only one answered from the board.
    expect((await answer(plain, true)).status).toBe(200);
    expect((await answer(gated, false)).status).toBe(200);
  });
});
