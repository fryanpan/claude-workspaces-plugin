/**
 * One act by a person on an agent's review item costs that agent one turn.
 *
 * Bryan, 27 Oct, after one answer reached the lead as three frames: "Why did
 * you get three separate events? That seems like a waste of tokens". The
 * answer arrived as `decision.answered` (the words), `workspace.review_answered`
 * (the lead's nudge) and `review_item.answered` (the filer's notice), and a
 * comment on the item arrived as `thread.created` (the words) and a bare
 * `decision.info_requested`.
 *
 * Each case drives the act through the real route, reads every frame that
 * lands on the filing agent's stream, and hands each to the MCP child's own
 * renderer with that agent's id. The count is of notifications the renderer
 * sends — the turns the agent pays — not of frames, because a frame a page
 * still needs may ride the stream and be dropped in the child.
 *
 * The filer is also the board's lead here, which is the case that paid most:
 * both the lead-addressed nudge and the filer-addressed notice reached it.
 *
 * A sentinel act after each one bounds the window: frames on one stream keep
 * their order, so once the sentinel's frame has arrived every frame the act
 * caused has too, and a count of one is a count rather than a race.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChannelNotification, createChannelMessages } from '../../mcp/src/channel-messages.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type FrameListener, listenFrames } from './sse-frames.ts';
import { waitFor } from './wait-for.ts';

const AGENT = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };
const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'person' };
const TITLE = 'Agent can rebuild the Riverbend index nightly';
const HEADLINE = 'Which key should the nightly rebuild sort on?';
const DETAIL = 'The existing key keeps old links working; a fresh key halves the rebuild time.';

describe('one act on a review item wakes its filer once', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let WS = '';
  let stream: FrameListener;
  let sentinels = 0;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  /** Every notification the agent's MCP child sends for these frames. */
  async function wakes(from: number, to: number): Promise<ChannelNotification['params'][]> {
    const out: ChannelNotification['params'][] = [];
    const messages = createChannelMessages({
      notify: async (n) => {
        out.push(n.params);
      },
      http: async () => ({}),
      authorId: AGENT.id,
    });
    for (const f of stream.frames.slice(from, to)) {
      await messages.emitChannelMessage(f.event, f.data);
    }
    return out;
  }

  /** A person's unrelated act; returns the index of its frame on the stream. */
  async function sentinel(): Promise<number> {
    sentinels += 1;
    const title = `Sentinel ${sentinels}`;
    await jj(
      await post(`/workspaces/${WS}/tasks`, {
        title,
        body: 'Bob can see where the window ends so that a count is a count.',
        author: PERSON,
      }),
    );
    return waitFor(
      () => {
        const i = stream.frames.findIndex(
          (f) =>
            f.event === 'task.created' &&
            (f.data?.task as { title?: string } | undefined)?.title === title,
        );
        return i >= 0 ? i : undefined;
      },
      { describe: `the ${title} frame` },
    );
  }

  /** A task the agent filed, holding one decision item the agent filed. */
  async function fileItem(): Promise<{ taskId: string; itemId: string }> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${WS}/tasks`, {
        title: TITLE,
        body: 'Agent can refresh the index on a schedule so that search stays current.',
        links: [{ kind: 'doc', docId: 'search-plan' }],
        author: AGENT,
      }),
    );
    const { item } = await jj<{ item: { id: string } }>(
      await post(`/workspaces/${WS}/tasks/${task.id}/review-items`, {
        review: {
          shape: 'decision',
          headline: HEADLINE,
          detail: DETAIL,
          options: [
            { id: 'o-1', label: 'The existing key' },
            { id: 'o-2', label: 'A fresh key' },
          ],
        },
        author: AGENT,
      }),
    );
    return { taskId: task.id, itemId: item.id };
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'one-wake-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string; leadAgentId?: string } }>(
      await post('/workspaces', { name: 'Riverbend search', leadAgentId: AGENT.id }),
    );
    WS = workspace.id;
    expect(workspace.leadAgentId).toBe(AGENT.id);
    await jj(
      await post(`/workspaces/${WS}/agents`, {
        agentId: AGENT.id,
        agentName: AGENT.name,
        runtime: 'claude-code-local',
      }),
    );
    await jj(await post(`/api/agents/${AGENT.id}/watches`, { add: [`ws:${WS}`] }));
    stream = listenFrames(await fetch(`${base}/events/agent/${AGENT.id}`));
  });

  afterEach(async () => {
    await stream.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('an answer is one wake, carrying the answer, the title, the item and the checklist', async () => {
    const { taskId, itemId } = await fileItem();
    const start = await sentinel();

    await jj(
      await post(`/workspaces/${WS}/tasks/${taskId}/review-items/${itemId}/answer`, {
        text: 'A fresh key',
        answeredWith: 'o-2',
        author: PERSON,
      }),
    );
    const end = await sentinel();

    // POSITIVE CONTROL: the answer reached this stream at all.
    expect(stream.frames.slice(start, end).map((f) => f.event)).toContain('decision.answered');

    const got = await wakes(start + 1, end);
    expect(got.map((n) => n.meta.event)).toEqual(['decision.answered']);
    const line = got[0]?.content ?? '';
    expect(line).toContain('"A fresh key"');
    expect(line).toContain(TITLE);
    expect(line).toContain(itemId);
    expect(line).toContain(HEADLINE);
    expect(line).toContain('walk its links as the propagation checklist');
    expect(got[0]?.meta.review_item_id).toBe(itemId);
  }, 60_000);

  it('a question typed into the answer box is one wake, carrying the words', async () => {
    const { taskId, itemId } = await fileItem();
    const start = await sentinel();

    const asked = await jj<{ asked?: boolean }>(
      await post(`/workspaces/${WS}/tasks/${taskId}/review-items/${itemId}/answer`, {
        text: 'Does the fresh key break old bookmarks?',
        author: PERSON,
      }),
    );
    // POSITIVE CONTROL: this went the ask-back way, not the answer way.
    expect(asked.asked).toBe(true);
    const end = await sentinel();
    expect(stream.frames.slice(start, end).map((f) => f.event)).toContain(
      'decision.info_requested',
    );

    const got = await wakes(start + 1, end);
    expect(got.map((n) => n.meta.event)).toEqual(['thread.created']);
    expect(got[0]?.content).toContain('Does the fresh key break old bookmarks?');
    expect(got[0]?.content).toContain(itemId);
  }, 60_000);

  it('a comment anchored on the item is one wake, carrying the words', async () => {
    const { taskId, itemId } = await fileItem();
    const start = await sentinel();

    await jj(
      await post(`/workspaces/${WS}/docs/task:${taskId}/threads`, {
        author: PERSON,
        text: 'How much is half, in minutes?',
        anchor: { kind: 'review-item', reviewItemId: itemId, snippet: { text: 'halves' } },
      }),
    );
    const end = await sentinel();
    expect(stream.frames.slice(start, end).map((f) => f.event)).toContain(
      'decision.info_requested',
    );

    const got = await wakes(start + 1, end);
    expect(got.map((n) => n.meta.event)).toEqual(['thread.created']);
    expect(got[0]?.content).toContain('How much is half, in minutes?');
  }, 60_000);

  // The control for the two above: the drop keys on the thread, not the name.
  it('a typed "tell me more" with no thread still wakes once, with the words', async () => {
    const { taskId, itemId } = await fileItem();
    const start = await sentinel();

    await jj(
      await post(`/workspaces/${WS}/tasks/${taskId}/review-items/${itemId}/more-info`, {
        question: 'What does a rebuild cost today?',
        author: PERSON,
      }),
    );
    const end = await sentinel();

    const got = await wakes(start + 1, end);
    expect(got.map((n) => n.meta.event)).toEqual(['decision.info_requested']);
    expect(got[0]?.content).toContain('What does a rebuild cost today?');
    expect(got[0]?.content).toContain(itemId);
  }, 60_000);
});
