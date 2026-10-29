/**
 * A grant card and a secret card are answered only through their own doors:
 * the owner's Approve (`…/grant`) and the values form (`…/secrets`). Voice
 * used to be a third door for both — it offered every open ticket item to the
 * classifier and recorded the transcript as the answer, so a spoken secret
 * landed in the feed and a spoken "approve" closed a grant card with nothing
 * written. The refusal now lives in the store, and voice no longer offers
 * either shape.
 *
 * Driven through a real server with the voice classifier stubbed at its seam;
 * no model is called. Every fixture is invented.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { FILER, LEAD, PERSON } from './review-judge-harness.ts';
import { type SignedInPerson, signedInPerson } from './signed-in-person.ts';

let handle: ServerHandle | undefined;
let dataDir = '';
let base = '';
let classification = '';
/** The person speaking, signed in on the board's own page: a person's spoken
 *  answer is recorded only on that proof (`review-items/answer-proof.ts`). */
let speaker: SignedInPerson;

function boot(): void {
  dataDir = mkdtempSync(join(tmpdir(), 'voice-grant-secret-'));
  handle = createServer({
    port: 0,
    dataDir,
    keepMovingCadenceMs: 0,
    answerCoverage: async () => null,
    voiceComplete: async () => classification,
  });
  base = `http://127.0.0.1:${handle.port}`;
  speaker = signedInPerson(handle, dataDir, `localhost:${handle.port}`, {
    name: PERSON.name,
  });
}

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

// The voice route is trusted-local, so every request names a local host.
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: `localhost:${handle?.port}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
const jj = async <T>(res: Response | Promise<Response>): Promise<T> => {
  const r = await res;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

const GRANT = {
  review_type: 'grant',
  headline: 'Allow the Harborlight release push until this task closes',
  allowRules: ['Bash(git push --force-with-lease:*)'],
};
const SECRET = {
  shape: 'secret',
  headline: 'Paste the Riverbend relay account name',
  secrets: [{ label: 'Relay account name', service: 'riverbend-relay-account' }],
};
const QUESTION = { shape: 'review', headline: 'Should the Saltmarsh export run at 04:00?' };

/** A board, a task on it, and one item of `review`'s shape on the task. */
async function fileItem(review: unknown): Promise<{ ws: string; taskId: string; itemId: string }> {
  const { workspace } = await jj<{ workspace: { id: string } }>(
    post('/workspaces', { name: 'harborlight-release', leadAgentId: LEAD.id }),
  );
  const ws = workspace.id;
  const { task } = await jj<{ task: { id: string } }>(
    post(`/workspaces/${ws}/tasks`, {
      title: 'Ship the Harborlight release',
      assignee: FILER.name,
      assigneeKind: 'agent',
      author: FILER,
    }),
  );
  const { item } = await jj<{ item: { id: string } }>(
    post(`/workspaces/${ws}/tasks/${task.id}/review-items`, { review, author: FILER }),
  );
  return { ws, taskId: task.id, itemId: item.id };
}

async function speak(ws: string, taskId: string, itemId: string, transcript: string) {
  classification = JSON.stringify({ kind: 'action', action: 'answer-review', id: taskId });
  return jj<{ route: string }>(
    post(
      `/workspaces/${ws}/voice`,
      {
        transcript,
        context: { surface: 'task', taskId, reviewItemId: itemId },
        author: speaker.user,
      },
      speaker.headers,
    ),
  );
}

describe('voice cannot answer a grant card or a secret card', () => {
  it('POSITIVE CONTROL: the same spoken answer closes an ordinary question', async () => {
    boot();
    const { ws, taskId, itemId } = await fileItem(QUESTION);
    const body = await speak(ws, taskId, itemId, 'yes, run it at 04:00');
    expect(body.route).toBe('fast-path-action');
    const stored = handle?.tasks.listReviewItems(taskId).find((r) => r.id === itemId);
    expect(stored?.answer?.text).toBe('yes, run it at 04:00');
  });

  it('a spoken "approve" leaves a grant card open, for the owner to press', async () => {
    boot();
    const { ws, taskId, itemId } = await fileItem(GRANT);
    await speak(ws, taskId, itemId, 'approve');
    const stored = handle?.tasks.listReviewItems(taskId).find((r) => r.id === itemId);
    expect(stored?.answer).toBeUndefined();
    expect(stored?.partialAnswers).toBeUndefined();
  });

  it('a spoken value is never recorded as a secret card’s answer', async () => {
    boot();
    const { ws, taskId, itemId } = await fileItem(SECRET);
    await speak(ws, taskId, itemId, 'the account is harborlight-ops');
    const stored = handle?.tasks.listReviewItems(taskId).find((r) => r.id === itemId);
    expect(stored?.answer).toBeUndefined();
    expect(stored?.partialAnswers).toBeUndefined();
  });
});

describe('the store refuses a free-text answer to either shape', () => {
  it('refuses without the door, and records through the door that owns the shape', async () => {
    boot();
    const grant = await fileItem(GRANT);
    const tasks = handle?.tasks;
    if (!tasks) throw new Error('no server');
    const refused = tasks.answerTaskReview(grant.taskId, grant.itemId, 'approve', {
      actor: PERSON,
    });
    expect(refused).toMatchObject({ ok: false, error: 'grant-item' });
    // The other shape's door does not open this one.
    expect(
      tasks.answerTaskReview(grant.taskId, grant.itemId, 'approve', {
        actor: PERSON,
        door: 'secret',
      }),
    ).toMatchObject({ ok: false, error: 'grant-item' });
    expect(
      tasks.answerTaskReview(grant.taskId, grant.itemId, 'Approved.', {
        actor: PERSON,
        door: 'grant',
      }).ok,
    ).toBe(true);

    const secret = await fileItem(SECRET);
    expect(
      tasks.answerTaskReview(secret.taskId, secret.itemId, 'harborlight-ops', { actor: PERSON }),
    ).toMatchObject({ ok: false, error: 'secret-item' });
    expect(
      tasks.answerTaskReview(secret.taskId, secret.itemId, 'Saved: Relay account name', {
        actor: PERSON,
        door: 'secret',
      }).ok,
    ).toBe(true);
  });
});
