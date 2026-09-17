/**
 * The list of self-caused events, measured against a real server.
 *
 * `packages/mcp/test/no-self-echo.test.ts` proves the RENDERER says nothing
 * when a frame names this session. It cannot prove the list is the real one:
 * its payloads are written by hand, so a server that renamed an attribution
 * field — `actorId` for `actor`, say — would leave that file green while
 * production went back to echoing. This one drives the acts through the
 * routes, reads the frames off `/events/agent/<id>`, and asks the child's own
 * predicate about each.
 *
 * Three things are asserted per event, and the third is the one that matters:
 *
 *  1. the acting agent's stream carries the frame (the server broadcasts it —
 *     suppression is the child's job, not the wire's);
 *  2. a SECOND agent watching the same board carries it too, and the
 *     predicate says to deliver it there;
 *  3. the predicate says to suppress it on the actor's own stream.
 *
 * Then the same acts performed by a PERSON, where every agent must be told.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSelfAuthoredEvent } from '../../mcp/src/self-authored.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const ACTOR_AGENT = 'agent-harborlight';
const PEER_AGENT = 'agent-riverbend';
const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'person' };

type Frame = { event: string; data: Record<string, unknown> };

function listen(res: Response): { frames: Frame[]; stop: () => void } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          if (raw.startsWith(':')) continue;
          const f: Frame = { event: 'message', data: {} };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) f.event = line.slice(6).trim();
            else if (line.startsWith('data:')) f.data = JSON.parse(line.slice(5).trim());
          }
          frames.push(f);
        }
      }
    } catch {
      // Cancelled with a read in flight; the frames collected still stand.
    }
  })();
  return {
    frames,
    stop: () => {
      stopped = true;
      void reader.cancel();
    },
  };
}

/** Every event one session's own acts put on its own stream. */
const EXPECTED = [
  'agent.attached',
  'task.created',
  'task.transitioned',
  'task.assigned',
  'task.retitled',
  'review_item.added',
  'review_item.revised',
  'review_item.withdrawn',
  'review_item.answered',
  'decision.answered',
  'task.archived',
  'thread.created',
  'thread.replied',
  'thread.resolved',
  'suggestion.created',
  'agent.detached',
];

describe('an agent hears nothing about its own board acts', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let srcDir: string;
  let base: string;
  let WS = '';
  let docId = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  /**
   * Every act the probe found, performed as `who`.
   *
   * One helper for both arms so the person's run cannot quietly exercise a
   * different set of routes from the agent's.
   */
  const actAll = async (who: { id: string; name: string; kind: string }): Promise<void> => {
    await post(`/workspaces/${WS}/agents`, {
      agentId: who.id,
      agentName: who.name,
      runtime: 'claude-code-local',
    });
    const created = await post(`/workspaces/${WS}/tasks`, {
      title: 'A task',
      body: 'A body long enough to read as a real ticket body on the board.',
      author: who,
    });
    const taskId = ((await created.json()) as { task: { id: string } }).task.id;
    await post(`/workspaces/${WS}/tasks/${taskId}/transition`, { to: 'in-progress', author: who });
    await post(`/workspaces/${WS}/tasks/${taskId}/assignee`, { assignee: 'human', author: who });
    await post(`/workspaces/${WS}/tasks/${taskId}/title`, {
      title: 'A renamed task',
      reason: 'clearer',
      author: who,
    });

    // Two items, because a withdraw and an answer cannot both land on one:
    // the first is revised and then answered, the second withdrawn.
    const fileItem = async (headline: string): Promise<string> => {
      const added = await post(`/workspaces/${WS}/tasks/${taskId}/review-items`, {
        review: {
          shape: 'decision',
          headline,
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
        author: who,
      });
      return ((await added.json()) as { item: { id: string } }).item.id;
    };
    const answered = await fileItem('Which way?');
    await post(`/workspaces/${WS}/tasks/${taskId}/review-items/${answered}/revise`, {
      headline: 'Which way now?',
      author: who,
    });
    await post(`/workspaces/${WS}/tasks/${taskId}/review-items/${answered}/answer`, {
      text: 'A, for now.',
      answeredWith: 'a',
      author: who,
    });
    const withdrawn = await fileItem('And the other way?');
    await post(`/workspaces/${WS}/tasks/${taskId}/review-items/${withdrawn}/withdraw`, {
      reason: 'answered elsewhere',
      author: who,
    });

    const decision = await post(`/workspaces/${WS}/tasks`, {
      title: 'A decision',
      needs: 'decision',
      assignee: 'human',
      body: 'Thursday or Friday? Friday buys one more review pass and misses the demo.',
      author: who,
    });
    const decId = ((await decision.json()) as { task: { id: string } }).task.id;
    await post(`/workspaces/${WS}/tasks/${decId}/answer`, { text: 'Friday', author: who });
    await post(`/workspaces/${WS}/tasks/${decId}/archive`, { reason: 'answered', author: who });

    const thread = await post(`/workspaces/${WS}/docs/${docId}/threads`, {
      author: who,
      text: 'A comment.',
      anchor: { kind: 'subject' },
    });
    const threadId = ((await thread.json()) as { thread: { id: string } }).thread.id;
    await post(`/workspaces/${WS}/docs/${docId}/threads/${threadId}/comments`, {
      author: who,
      text: 'A reply.',
    });
    await post(`/workspaces/${WS}/docs/${docId}/threads/${threadId}/resolve`, { author: who });

    await post(`/workspaces/${WS}/docs/${docId}/find_and_replace`, {
      find: 'Body.',
      replace: 'Body, revised.',
      suggest: true,
      author: { id: who.id, name: who.name, color: '#2e7dd7' },
    });

    await fetch(`${base}/workspaces/${WS}/agents/${encodeURIComponent(who.id)}`, {
      method: 'DELETE',
      headers: { host: `localhost:${handle.port}` },
    });
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'self-echo-'));
    srcDir = mkdtempSync(join(tmpdir(), 'self-echo-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    const path = join(srcDir, 'doc-one.md');
    writeFileSync(path, '# doc-one\n\nBody.\n');
    const res = await post(`/workspaces/${WS}/docs`, {
      docId: 'doc-one',
      sourceUrl: path,
      title: 'doc-one',
    });
    docId = ((await res.json()) as { docId: string }).docId;
    for (const agent of [ACTOR_AGENT, PEER_AGENT]) {
      await post(`/api/agents/${agent}/watches`, { add: [docId, `ws:${WS}`] });
    }
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('suppresses each of its own events, and only on its own stream', async () => {
    const mine = listen(await get(`/events/agent/${ACTOR_AGENT}`));
    const theirs = listen(await get(`/events/agent/${PEER_AGENT}`));

    await actAll({ id: ACTOR_AGENT, name: 'Harborlight', kind: 'agent' });
    await waitFor(() => EXPECTED.every((e) => mine.frames.some((f) => f.event === e)));
    await waitFor(() => EXPECTED.every((e) => theirs.frames.some((f) => f.event === e)));

    // The wire carries every one of them to both agents — the server does not
    // address these, and the peer's copy is the positive control that proves
    // the frames are real.
    const heard = new Set(mine.frames.map((f) => f.event));
    expect(EXPECTED.filter((e) => !heard.has(e))).toEqual([]);

    // The actor's child suppresses each one …
    const notSuppressed = EXPECTED.filter(
      (event) =>
        !isSelfAuthoredEvent(event, mine.frames.find((f) => f.event === event)?.data, ACTOR_AGENT),
    );
    expect(notSuppressed).toEqual([]);

    // … and the peer's child suppresses none of them.
    const wronglySuppressed = EXPECTED.filter((event) =>
      isSelfAuthoredEvent(event, theirs.frames.find((f) => f.event === event)?.data, PEER_AGENT),
    );
    expect(wronglySuppressed).toEqual([]);

    mine.stop();
    theirs.stop();
  }, 60_000);

  it('delivers every one of them to both agents when a person acted', async () => {
    const mine = listen(await get(`/events/agent/${ACTOR_AGENT}`));

    // Attach/detach name the agent that attached, so a person's run produces
    // neither. Everything else is the person's.
    const byPerson = EXPECTED.filter((e) => !e.startsWith('agent.'));
    await actAll(PERSON);
    await waitFor(() => byPerson.every((e) => mine.frames.some((f) => f.event === e)));

    const wronglySuppressed = byPerson.filter((event) =>
      isSelfAuthoredEvent(event, mine.frames.find((f) => f.event === event)?.data, ACTOR_AGENT),
    );
    expect(wronglySuppressed).toEqual([]);

    mine.stop();
  }, 60_000);
});
