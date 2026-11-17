/**
 * A comment addressed to Alice notifies only Alice. An unaddressed comment,
 * a share visitor's included, still reaches the board's lead. An addressed
 * comment stays visible on every page that shows the doc.
 *
 * Real server behind the share-proof harness: Alice and Bob are board members
 * who prove themselves with Access tokens on the share host.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { emailIdentityId } from '@claude-workspaces/core';
import { type Frame, LEAD, listenFrames } from './doc-activity-stall-harness.ts';
import {
  type ShareProofServer,
  post,
  readJson,
  startShareProofServer,
} from './share-proof-harness.ts';
import { waitFor } from './wait-for.ts';

const ALICE = 'alice@harborlight.example';
const BOB = 'bob@riverbend.example';
const OWNER = { id: 'known-owner', name: 'Saltmarsh', kind: 'known' };
const HELPER = { id: 'agent-riverbend-helper', name: 'Riverbend Helper', kind: 'agent' };
const aliceId = emailIdentityId(ALICE);
const bobId = emailIdentityId(BOB);

describe('addressed comments', () => {
  let s: ShareProofServer;
  let taskId = '';
  let lead: ReturnType<typeof listenFrames>;
  let page: ReturnType<typeof listenFrames>;
  let aliceInbox: ReturnType<typeof listenFrames>;
  let bobInbox: ReturnType<typeof listenFrames>;
  const streams: Array<ReturnType<typeof listenFrames>> = [];

  const threads = () => `${s.scope}/docs/task:${taskId}/threads`;
  const comment = (text: string, extra: Record<string, unknown> = {}) =>
    post({ text, anchor: { kind: 'subject' }, author: OWNER, ...extra });
  const threadIdOf = async (res: Response) =>
    (await readJson<{ thread: { id: string } }>(res)).thread.id;
  const hasThread = (frames: Frame[], threadId: string) =>
    frames.some((f) => f.data?.threadId === threadId);
  const stream = async (res: Response) => {
    expect(res.status).toBe(200);
    const l = listenFrames(res);
    streams.push(l);
    return l;
  };
  const SSE = { headers: { accept: 'text/event-stream' } };

  beforeAll(async () => {
    s = await startShareProofServer('Harborlight addressing');
    s.handle.shareLinks.addToAudience(s.board, [ALICE, BOB], 'Saltmarsh');
    expect(await s.join(ALICE)).toBe(302);
    expect(await s.join(BOB)).toBe(302);
    for (const agent of [LEAD, HELPER]) {
      await readJson(
        await s.local(
          `${s.scope}/agents`,
          post({ agentId: agent.id, agentName: agent.name, runtime: 'claude-code-local' }),
        ),
      );
    }
    s.handle.tasks.setLeadAgent(s.board, LEAD.id, { actor: OWNER });
    taskId = (
      await readJson<{ task: { id: string } }>(
        await s.local(
          `${s.scope}/tasks`,
          post({
            title: 'Harborlight export',
            body: 'Agent can export the rows so that the report is complete.',
            author: LEAD,
          }),
        ),
      )
    ).task.id;
    lead = await stream(
      await s.local(`${s.scope}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`, SSE),
    );
    page = await stream(await s.local(`${s.scope}/events:stream`, SSE));
    aliceInbox = await stream(await s.visitor(ALICE, `${s.scope}/me/events:stream`, SSE));
    bobInbox = await stream(await s.visitor(BOB, `${s.scope}/me/events:stream`, SSE));
  });

  afterAll(async () => {
    for (const l of streams) await l.stop();
    await s.stop();
  });

  it('a comment to Alice reaches Alice, the page and nobody else', async () => {
    const forAlice = await threadIdOf(
      await s.local(threads(), comment('Alice, can you check?', { to: [aliceId] })),
    );
    // Sentinels: one to Bob, one to nobody. Each stream's sentinel arriving
    // first is what makes the absence of the first comment a reading.
    const forBob = await threadIdOf(
      await s.local(threads(), comment('Bob, yours.', { to: [bobId] })),
    );
    const forAll = await threadIdOf(await s.local(threads(), comment('Everyone.')));

    await waitFor(() => hasThread(aliceInbox.frames, forAlice), {
      describe: "Alice's inbox frame",
    });
    const frame = aliceInbox.frames.find((f) => f.data?.threadId === forAlice);
    expect(frame?.event).toBe('comment.addressed');
    expect(frame?.data?.text).toBe('Alice, can you check?');
    await waitFor(() => hasThread(bobInbox.frames, forBob), { describe: "Bob's inbox frame" });
    expect(hasThread(bobInbox.frames, forAlice)).toBe(false);

    await waitFor(() => hasThread(lead.frames, forAll), {
      describe: 'the unaddressed comment on the lead stream',
    });
    expect(hasThread(lead.frames, forAlice)).toBe(false);
    const rows = s.handle.tasks.listQueuedComments(s.board);
    expect(rows.some((r) => r.threadId === forAll && r.agentId === LEAD.id)).toBe(true);
    expect(rows.some((r) => r.threadId === forAlice)).toBe(false);

    await waitFor(() => hasThread(page.frames, forAll), { describe: 'the page frame' });
    expect(hasThread(page.frames, forAlice)).toBe(true);

    const read = await readJson<{ thread: { waitingOn?: string[] } }>(
      await s.local(`${s.scope}/docs/task:${taskId}/threads/${forAlice}`),
    );
    expect(read.thread.waitingOn).toEqual([aliceId]);
  });

  it('a comment to an agent queues a row for that agent and none for the lead', async () => {
    const forHelper = await threadIdOf(
      await s.local(threads(), comment('Helper, take this.', { to: [HELPER.id] })),
    );
    const rows = s.handle.tasks.listQueuedComments(s.board).filter((r) => r.threadId === forHelper);
    expect(rows.map((r) => r.agentId)).toEqual([HELPER.id]);
  });

  it("an unaddressed share visitor's comment still reaches the lead", async () => {
    const fromAlice = await threadIdOf(
      await s.visitor(ALICE, threads(), post({ text: 'From Alice.', anchor: { kind: 'subject' } })),
    );
    await waitFor(() => hasThread(lead.frames, fromAlice), {
      describe: "Alice's comment on the lead stream",
    });
    expect(
      s.handle.tasks
        .listQueuedComments(s.board)
        .some((r) => r.threadId === fromAlice && r.agentId === LEAD.id),
    ).toBe(true);
  });

  it('refuses an addressee who is not on the board, and ignores a body addressedTo', async () => {
    for (const to of [
      ['saltmarsh@nowhere.example'],
      ['Nobody Here'],
      [emailIdentityId('x@nowhere.example')],
    ]) {
      const res = await s.local(threads(), comment('Who?', { to }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_addressee' });
    }
    const forged = await readJson<{ thread: { comments: Array<{ addressedTo?: unknown }> } }>(
      await s.local(
        threads(),
        comment('Forged.', { addressedTo: [{ id: aliceId, kind: 'person', name: 'Alice' }] }),
      ),
    );
    expect(forged.thread.comments[0]?.addressedTo).toBeUndefined();
  });

  it('opens the person stream only for a request that proved a person', async () => {
    expect((await s.local(`${s.scope}/me/events:stream`, SSE)).status).toBe(401);
  });
});
