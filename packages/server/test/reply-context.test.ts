/**
 * A reply frame says where the comment came from and what it answers.
 *
 * An agent was handed `[replied] <owner>: Go ahead` with nothing to say what
 * "go ahead" was about. The frame now names the doc — a task's own comments
 * name the TASK, since a `task:` doc has no title of its own — and carries
 * the comment the reply follows as `inReplyTo`. Read off the lead's board
 * stream, which is the channel a watching agent consumes.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IN_REPLY_TO_MAX } from '../src/live-doc-fanout.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type Frame, LEAD, PERSON, listenFrames } from './doc-activity-stall-harness.ts';
import { waitFor } from './wait-for.ts';

const ASK = 'Should I delete the old Harborlight fixtures, or keep them for the migration test?';

describe('reply frames carry their context', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId = '';
  let lead: ReturnType<typeof listenFrames>;

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

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'reply-context-'));
    handle = createServer({ port: 0, dataDir, keepMovingCadenceMs: 0 });
    base = `http://127.0.0.1:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'riverbend-fixtures', leadAgentId: LEAD.id }),
    );
    workspaceId = workspace.id;
    await jj(
      await post(`/workspaces/${workspaceId}/agents`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    const res = await fetch(
      `${base}/workspaces/${workspaceId}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    lead = listenFrames(res);
  });

  afterEach(async () => {
    await lead.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Open a thread with `ASK` on `docId`, reply to it, return the reply frame. */
  async function replyOn(docId: string, reply: string): Promise<Record<string, unknown>> {
    const { thread } = await jj<{ thread: { id: string } }>(
      await post(`/workspaces/${workspaceId}/docs/${docId}/threads`, {
        author: LEAD,
        text: ASK,
        anchor: { kind: 'subject' },
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/docs/${docId}/threads/${thread.id}/comments`, {
        author: PERSON,
        text: reply,
      }),
    );
    const frame = await waitFor(
      () =>
        lead.frames.find(
          (f: Frame) => f.data?.event === 'thread.replied' && f.data?.threadId === thread.id,
        ),
      { timeout: 10_000, interval: 25, describe: 'the thread.replied frame on the lead stream' },
    );
    return frame.data as Record<string, unknown>;
  }

  it("a reply on a task's own comments names the task and quotes the comment it answers", async () => {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title: 'Upload test is flaky',
        body: 'Agent can run the upload test so that it passes every time.',
        author: LEAD,
      }),
    );
    // Renamed after its comment doc was made: the frame names the task as it
    // is now, not the title the doc was stamped with at creation.
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/title`, {
        title: 'Fix the flaky upload test',
        author: LEAD,
      }),
    );
    const frame = await replyOn(`task:${task.id}`, 'Go ahead');

    expect(frame.docTitle).toBe('Fix the flaky upload test');
    expect(frame.inReplyTo).toMatchObject({ author: LEAD.name, text: ASK });
  });

  it("a reply on a doc names the doc's title and cuts a long parent", async () => {
    const src = mkdtempSync(join(tmpdir(), 'reply-context-src-'));
    try {
      const path = join(src, 'plan.md');
      writeFileSync(path, '# Saltmarsh rollout\n\nBody.\n');
      await jj(
        await post(`/workspaces/${workspaceId}/docs`, {
          docId: 'saltmarsh-plan',
          sourceUrl: path,
          title: 'Saltmarsh rollout plan',
        }),
      );
      const { thread } = await jj<{ thread: { id: string } }>(
        await post(`/workspaces/${workspaceId}/docs/saltmarsh-plan/threads`, {
          author: LEAD,
          text: 'x'.repeat(IN_REPLY_TO_MAX + 50),
          anchor: { kind: 'subject' },
        }),
      );
      await jj(
        await post(`/workspaces/${workspaceId}/docs/saltmarsh-plan/threads/${thread.id}/comments`, {
          author: PERSON,
          text: 'Shorter, please',
        }),
      );
      const frame = await waitFor(
        () =>
          lead.frames.find(
            (f: Frame) => f.data?.event === 'thread.replied' && f.data?.threadId === thread.id,
          ),
        { timeout: 10_000, interval: 25, describe: 'the doc reply frame' },
      );
      expect(frame.data?.docTitle).toBe('Saltmarsh rollout plan');
      const parent = frame.data?.inReplyTo as { author: string; text: string };
      expect(parent.author).toBe(LEAD.name);
      expect(parent.text).toHaveLength(IN_REPLY_TO_MAX);
      expect(parent.text.endsWith('…')).toBe(true);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('a new thread carries the title but nothing it replies to', async () => {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title: 'Rename the Riverbend bucket',
        body: 'Agent can rename the bucket so that the name matches the service.',
        author: LEAD,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/docs/task:${task.id}/threads`, {
        author: PERSON,
        text: 'Which region is it in?',
        anchor: { kind: 'subject' },
      }),
    );
    const frame = await waitFor(
      () => lead.frames.find((f: Frame) => f.data?.event === 'thread.created'),
      { timeout: 10_000, interval: 25, describe: 'the thread.created frame' },
    );
    expect(frame.data?.docTitle).toBe('Rename the Riverbend bucket');
    expect(frame.data?.inReplyTo).toBeUndefined();
  });
});
