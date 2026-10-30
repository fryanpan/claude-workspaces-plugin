/**
 * Only the person answers as that person (Bryan, 29 Oct: an agent cannot
 * approve its own ask), through the real routes.
 *
 * A loopback request is every agent on this machine. One that names the owner
 * in its body — `{ id: 'known-bryan', kind: 'person' }`, or the same id with
 * `kind: 'agent'` — is refused on every answer door and changes nothing. The
 * owner's own signed-in page, sent same-origin, still records as his, and an
 * agent answering as itself still records as the agent's.
 *
 * The positive control in every block is the same request carrying the
 * owner's proof, so a refusal here is the check and not a broken fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thread } from '@claude-workspaces/core';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';
import { type SignedInPerson, signedInPerson } from './signed-in-person.ts';

const OWNER_EMAIL = 'owner@harborlight.test';
const AGENT = { id: 'agent-riverbend', name: 'Riverbend Bot', kind: 'agent' };
const CLAIMS = [
  { id: 'known-bryan', name: 'Bryan', kind: 'person' },
  { id: 'known-bryan', name: 'Bryan', kind: 'agent' },
  { id: 'known-bryan', name: 'Bryan' },
];
const DECISION = {
  shape: 'decision',
  headline: 'Ship the Saltmarsh release notes today?',
  detail: 'They are drafted and reviewed. Shipping today beats the Friday freeze.',
  options: [
    { id: 'yes', label: 'Ship today' },
    { id: 'no', label: 'Hold for Monday' },
  ],
};

const QUESTION = { shape: 'review', headline: 'Should the Saltmarsh export run at 04:00?' };
const SECRET = {
  shape: 'secret',
  headline: 'Paste the Riverbend relay account name',
  secrets: [{ label: 'Relay account name', service: 'riverbend-relay-account' }],
};

interface Item {
  id: string;
  answer?: { text: string; actor?: { id: string }; answeredBy?: { id: string } };
}

describe("an answer is a person's only when the request proves the person", () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;
  let owner: SignedInPerson;
  /** What the stubbed voice classifier answers next. */
  let classification = '';
  /** The services the stubbed secret writer was handed. */
  const written: string[] = [];

  const send = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const ok = async <T>(res: Response): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as T;
  };

  async function fileItem(review: unknown = DECISION): Promise<{ taskId: string; itemId: string }> {
    const { task } = await ok<{ task: Task }>(
      await send(`/workspaces/${ws}/tasks`, {
        title: 'Agent can ship the Saltmarsh notes so that the release is not held',
        author: AGENT,
      }),
    );
    const { item } = await ok<{ item: { id: string } }>(
      await send(`/workspaces/${ws}/tasks/${task.id}/review-items`, {
        review,
        author: AGENT,
      }),
    );
    return { taskId: task.id, itemId: item.id };
  }
  async function itemOf(taskId: string, itemId: string): Promise<Item | undefined> {
    const { tasks } = await ok<{ tasks: Array<Task & { reviews?: Item[] }> }>(
      await fetch(`${base}/workspaces/${ws}/tasks?format=json`),
    );
    return tasks.find((t) => t.id === taskId)?.reviews?.find((r) => r.id === itemId);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'answer-proof-'));
    handle = createServer({
      port: 0,
      dataDir,
      ownerEmail: OWNER_EMAIL,
      answerCoverage: async () => null,
      voiceComplete: async () => classification,
      secretWriter: async (service: string) => {
        written.push(service);
        return { ok: true };
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    ws = (
      await ok<{ workspace: { id: string } }>(
        await send('/workspaces', { name: 'Harborlight release', author: AGENT }),
      )
    ).workspace.id;
    owner = signedInPerson(handle, dataDir, base, { email: OWNER_EMAIL, name: 'Bryan' });
  });
  afterAll(async () => {
    await handle.stop();
    resetOwnerIdentities();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('a ticket review item', () => {
    it('refuses every loopback claim of the owner, and records nothing', async () => {
      const { taskId, itemId } = await fileItem();
      for (const claim of CLAIMS) {
        const res = await send(`/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/answer`, {
          text: 'Ship today',
          answeredWith: 'yes',
          author: claim,
        });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe('person-proof-required');
      }
      expect((await itemOf(taskId, itemId))?.answer).toBeUndefined();
    });

    it("records the owner's answer from his own signed-in page as his", async () => {
      const { taskId, itemId } = await fileItem();
      await ok(
        await send(
          `/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/answer`,
          { text: 'Ship today', answeredWith: 'yes', author: CLAIMS[0] },
          owner.headers,
        ),
      );
      const answer = (await itemOf(taskId, itemId))?.answer;
      expect(answer?.text).toBe('Ship today');
      expect(answer?.answeredBy?.id).toBe(owner.user.id);
    });

    it("refuses the owner's cookie sent from another page", async () => {
      const { taskId, itemId } = await fileItem();
      const res = await send(
        `/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/answer`,
        { text: 'Ship today', author: CLAIMS[0] },
        { cookie: owner.headers.cookie ?? '' },
      );
      expect(res.status).toBe(403);
      expect((await itemOf(taskId, itemId))?.answer).toBeUndefined();
    });

    it("records an agent's answer as the agent's, approving nothing", async () => {
      const { taskId, itemId } = await fileItem();
      await ok(
        await send(`/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/answer`, {
          text: 'Ship today',
          author: AGENT,
        }),
      );
      const answer = (await itemOf(taskId, itemId))?.answer;
      expect(answer?.text).toBe('Ship today');
      expect(answer?.answeredBy).toBeUndefined();
    });

    it("refuses a loopback undo of the owner's answer", async () => {
      const { taskId, itemId } = await fileItem();
      await ok(
        await send(
          `/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/answer`,
          { text: 'Ship today', author: CLAIMS[0] },
          owner.headers,
        ),
      );
      const undo = `/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/answer/undo`;
      expect((await send(undo, { author: CLAIMS[0] })).status).toBe(403);
      expect((await itemOf(taskId, itemId))?.answer?.text).toBe('Ship today');
      await ok(await send(undo, { author: CLAIMS[0] }, owner.headers));
      expect((await itemOf(taskId, itemId))?.answer).toBeUndefined();
    });
  });

  describe("a ticket's own decision", () => {
    it('refuses a loopback claim of the owner and takes his signed-in answer', async () => {
      const { task } = await ok<{ task: Task }>(
        await send(`/workspaces/${ws}/tasks`, {
          title: 'Agent can pick the Riverbend freeze date so that the release lands',
          needs: 'decision',
          body: 'Freeze Friday or Monday? Friday costs the last fixes and keeps the date. Blocked until answered: the release note.',
          options: [
            { id: 'fri', label: 'Friday' },
            { id: 'mon', label: 'Monday' },
          ],
          author: AGENT,
        }),
      );
      const path = `/workspaces/${ws}/tasks/${task.id}/answer`;
      const refused = await send(path, { text: 'Friday', author: CLAIMS[0] });
      expect(refused.status).toBe(403);
      await ok(await send(path, { text: 'Friday', author: CLAIMS[0] }, owner.headers));
      const { tasks } = await ok<{ tasks: Task[] }>(
        await fetch(`${base}/workspaces/${ws}/tasks?format=json`),
      );
      const answered = tasks.find((t) => t.id === task.id);
      expect(answered?.answer?.text).toBe('Friday');
      expect(answered?.answer?.by).toBe('Bryan');
    });
  });

  describe('a doc thread item', () => {
    async function fileThread(): Promise<{ docId: string; threadId: string; commentId: string }> {
      const docId = `answer-proof-${Math.random().toString(36).slice(2, 8)}`;
      const sourceUrl = join(dataDir, `${docId}.md`);
      writeFileSync(sourceUrl, '# Notes\n\nThe release notes draft.\n');
      await ok(await send(`/workspaces/${ws}/docs`, { docId, type: 'markdown', sourceUrl }));
      const { thread } = await ok<{ thread: Thread }>(
        await send(`/workspaces/${ws}/docs/${docId}/threads/by_find`, {
          find: 'release notes draft',
          text: DECISION.headline,
          review: DECISION,
          author: AGENT,
        }),
      );
      return { docId, threadId: thread.id, commentId: thread.comments[0]?.id ?? '' };
    }
    async function declaration(docId: string, threadId: string) {
      const { thread } = await ok<{ thread: Thread }>(
        await fetch(`${base}/workspaces/${ws}/docs/${docId}/threads/${threadId}`),
      );
      return thread.comments[0]?.review;
    }

    it('refuses a loopback claim of the owner at /answer and takes his signed-in one', async () => {
      const { docId, threadId, commentId } = await fileThread();
      const path = `/workspaces/${ws}/docs/${docId}/threads/${threadId}/answer`;
      for (const claim of CLAIMS) {
        const res = await send(path, {
          text: 'Ship today',
          optionId: 'yes',
          commentId,
          author: claim,
        });
        expect(res.status).toBe(403);
      }
      expect((await declaration(docId, threadId))?.answeredAt).toBeUndefined();
      await ok(
        await send(
          path,
          { text: 'Ship today', optionId: 'yes', commentId, author: CLAIMS[0] },
          owner.headers,
        ),
      );
      expect((await declaration(docId, threadId))?.answeredBy).toBe('Bryan');
    });

    it("posts a loopback reply in the owner's name as a comment that answers nothing", async () => {
      const { docId, threadId } = await fileThread();
      const path = `/workspaces/${ws}/docs/${docId}/threads/${threadId}/comments`;
      await ok(await send(path, { text: 'Ship today', author: CLAIMS[0] }));
      expect((await declaration(docId, threadId))?.answeredAt).toBeUndefined();
      // Positive control: the same reply from his signed-in page answers it.
      await ok(await send(path, { text: 'Ship today', author: CLAIMS[0] }, owner.headers));
      expect(typeof (await declaration(docId, threadId))?.answeredAt).toBe('number');
    });
  });
  describe('the spoken answer door', () => {
    const speak = (taskId: string, itemId: string, headers: Record<string, string> = {}) => {
      classification = JSON.stringify({ kind: 'action', action: 'answer-review', id: taskId });
      return send(
        `/workspaces/${ws}/voice`,
        {
          transcript: 'answer: ship it today',
          context: { surface: 'task', taskId, reviewItemId: itemId },
          author: CLAIMS[0],
        },
        headers,
      );
    };

    it("records no answer for a loopback claim of the owner, and records his own page's", async () => {
      const { taskId, itemId } = await fileItem(QUESTION);
      expect((await speak(taskId, itemId)).status).toBe(200);
      expect((await itemOf(taskId, itemId))?.answer).toBeUndefined();
      // Positive control: the same utterance from his signed-in page answers.
      expect((await speak(taskId, itemId, owner.headers)).status).toBe(200);
      expect((await itemOf(taskId, itemId))?.answer?.answeredBy?.id).toBe(owner.user.id);
    });
  });

  describe('the secrets door', () => {
    const save = (taskId: string, itemId: string, headers: Record<string, string> = {}) =>
      send(
        `/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/secrets`,
        {
          secrets: [{ service: 'riverbend-relay-account', value: 'harborlight-ops' }],
          author: CLAIMS[0],
        },
        headers,
      );

    it('refuses a loopback claim of the owner before writing a value', async () => {
      const { taskId, itemId } = await fileItem(SECRET);
      const refused = await save(taskId, itemId);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toBe('owner-proof-required');
      expect(written).toEqual([]);
      expect((await itemOf(taskId, itemId))?.answer).toBeUndefined();
      await ok(await save(taskId, itemId, owner.headers));
      expect(written).toEqual(['riverbend-relay-account']);
      // Recorded as the proven owner, not the body's claimed author.
      expect((await itemOf(taskId, itemId))?.answer?.answeredBy?.id).toBe(owner.user.id);
    });
  });

  it("refuses a signed-in person's id claimed over loopback with kind 'agent'", async () => {
    // A member, not the owner: the roster holds her row as a person's.
    const alice = signedInPerson(handle, dataDir, base, { name: 'Alice' });
    const { taskId, itemId } = await fileItem();
    const res = await send(`/workspaces/${ws}/tasks/${taskId}/review-items/${itemId}/answer`, {
      text: 'Ship today',
      author: { id: alice.user.id, name: 'Alice', kind: 'agent' },
    });
    expect(res.status).toBe(403);
    expect((await itemOf(taskId, itemId))?.answer).toBeUndefined();
  });
});
