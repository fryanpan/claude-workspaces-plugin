/**
 * A board has an Owner and Regular Users, and the API is what enforces it.
 *
 * Bryan, 2026-09-11: *"share a board with someone who can read and comment but
 * cannot act as him, so that a share link stops being a grant of everything he
 * can do"*. Until this, redeeming a link made you a member and every member
 * could do everything any other member could.
 *
 * This drives the real route table behind a real Cloudflare Access fixture,
 * because the gate is wired in the admission layer and a route that answered
 * before its gate ran would pass every unit test written about it. The harness
 * is `share-link-flow.test.ts`'s: two Access applications, two hostnames, and a
 * board shared by a link. The handler's own refusals, asserted against what the
 * store was asked to do, are `workspace-members-route.test.ts`.
 *
 * Every name here is invented. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'board-roles-kid';
const SHARE_AUD = 'aud-for-the-share-app';
const OWNER_AUD = 'aud-for-the-owner-app';
const SHARE_HOST = 'share.example.test';
const OWNER_HOST = 'workspaces.example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const REGULAR = 'keeper@harborlight.example';
const PROMOTED = 'pilot@saltmarsh.example';
const OWNER_EMAIL = 'owner@example.test';

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud, email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-board-roles')
      .sign(privateKey);
});

describe('the level is enforced by the API', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let board: string;
  let taskId: string;
  let gatedItem: string;
  let openItem: string;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });

  /** As the machine's owner — loopback, no proxy hop, no token. */
  const local = (path: string, init: RequestInit = {}) =>
    req(path, `localhost:${handle.port}`, init);

  const postLocal = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** On the share hostname, holding a token from the share application. */
  const asVisitor = async (email: string, path: string, init: RequestInit = {}) =>
    req(path, SHARE_HOST, {
      ...init,
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const postAsVisitor = async (email: string, path: string, body: unknown) =>
    asVisitor(email, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const putAsVisitor = async (email: string, path: string, body: unknown) =>
    asVisitor(email, path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** The board's own settings, as the operator reads them back. */
  const boardSettings = async (): Promise<{ criteria: string; cap: number }> => {
    const body = await jj<{
      reviewItemCriteria: { value: string };
      parallelismCap: { value: number };
    }>(await local(`/workspaces/${encodeURIComponent(board)}/settings`));
    return { criteria: body.reviewItemCriteria.value, cap: body.parallelismCap.value };
  };

  const jj = async <T>(res: Response): Promise<T> => {
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  /** Who the server says has access, read as the operator. */
  const roster = async (): Promise<Record<string, string>> => {
    const body = await jj<{ members: Array<{ email: string; role: string }> }>(
      await local(`/workspaces/${encodeURIComponent(board)}/members`),
    );
    return Object.fromEntries(body.members.map((m) => [m.email, m.role]));
  };

  /** The asks on the task, as the operator reads them off the board. */
  const itemsOnTask = async (): Promise<Array<{ id: string; answer?: { text?: string } }>> => {
    const body = await jj<{
      tasks: Array<{ id: string; reviews?: Array<{ id: string; answer?: { text?: string } }> }>;
    }>(await local(`/workspaces/${encodeURIComponent(board)}/tasks?format=json`));
    return body.tasks.find((t) => t.id === taskId)?.reviews ?? [];
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'board-roles-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      // The retired per-share mode alongside, as prod looks while its old
      // records drain — a shared verifier would otherwise resolve the share
      // hostname's audience out of the share registry and refuse everything.
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
    base = `http://127.0.0.1:${handle.port}`;

    const made = await jj<{ workspace: { id: string } }>(
      await postLocal('/workspaces', { name: 'Harborlight relay' }),
    );
    board = made.workspace.id;

    // Two people come in through links: one left at the default level, one
    // minted as an Owner — the ROLE ON THE LINK, so a board can hand out a
    // second owner without a second round trip.
    const plain = await jj<{ link: { linkId: string } }>(
      await postLocal('/api/share/workspace', { workspaceId: board }),
    );
    expect((await asVisitor(REGULAR, `/s/${plain.link.linkId}`)).status).toBe(302);
    const owning = await jj<{ link: { linkId: string } }>(
      await postLocal('/api/share/workspace', { workspaceId: board, role: 'owner' }),
    );
    expect((await asVisitor(PROMOTED, `/s/${owning.link.linkId}`)).status).toBe(302);

    const task = await jj<{ task: { id: string } }>(
      await postLocal(`/workspaces/${encodeURIComponent(board)}/tasks`, {
        title: 'Rebuild the Harborlight index nightly',
        body: 'Agent can rebuild the index so that search stays fresh.',
        author: { id: 'a-relay', name: 'Relay Bot', kind: 'agent' },
      }),
    );
    taskId = task.task.id;
    const ask = (headline: string, ownerOnly: boolean) => ({
      review: {
        shape: 'decision',
        headline,
        detail: 'The nightly pass reads the index once. A smaller cache makes it read twice.',
        options: [
          { id: 'o-yes', label: 'Go ahead' },
          { id: 'o-no', label: 'Leave it' },
        ],
        ...(ownerOnly ? { ownerOnly: true } : {}),
      },
      author: { id: 'a-relay', name: 'Relay Bot', kind: 'agent' },
    });
    const gated = await jj<{ item: { id: string } }>(
      await postLocal(
        `/workspaces/${encodeURIComponent(board)}/tasks/${taskId}/review-items`,
        ask('Run the reindex command on this machine?', true),
      ),
    );
    gatedItem = gated.item.id;
    const open = await jj<{ item: { id: string } }>(
      await postLocal(
        `/workspaces/${encodeURIComponent(board)}/tasks/${taskId}/review-items`,
        ask('Halve the nightly cache?', false),
      ),
    );
    openItem = open.item.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('shows every member who has access and at what level, to a Regular User too', async () => {
    // Everything in a workspace is available to everyone in it: a person who
    // cannot see who else is here cannot know who reads what they write.
    const body = await jj<{
      you: { email: string; role: string };
      members: Array<{ email: string; role: string }>;
    }>(await asVisitor(REGULAR, `/workspaces/${encodeURIComponent(board)}/members`));
    expect(body.you).toEqual({ email: REGULAR, role: 'member' });
    expect(Object.fromEntries(body.members.map((m) => [m.email, m.role]))).toEqual({
      [REGULAR]: 'member',
      [PROMOTED]: 'owner',
    });
    // No link ids, no tokens: `/api/share` is where those live, and it
    // refuses browsers outright.
    expect(JSON.stringify(body)).not.toContain('linkId');
  });

  it('refuses a Regular User’s change to the member list, and the board does not move', async () => {
    const before = await roster();
    const promote = await postAsVisitor(
      REGULAR,
      `/workspaces/${encodeURIComponent(board)}/members/${encodeURIComponent(REGULAR)}/role`,
      { role: 'owner' },
    );
    expect(promote.status).toBe(403);
    const evict = await asVisitor(
      REGULAR,
      `/workspaces/${encodeURIComponent(board)}/members/${encodeURIComponent(PROMOTED)}`,
      { method: 'DELETE' },
    );
    expect(evict.status).toBe(403);
    expect(await roster()).toEqual(before);
  });

  it('lets an Owner reaching the board through the share host change a level', async () => {
    // The point of the design: the gate is the ROLE, not the hostname. A
    // promoted guest manages the board; the Regular User beside them cannot.
    const res = await postAsVisitor(
      PROMOTED,
      `/workspaces/${encodeURIComponent(board)}/members/${encodeURIComponent(REGULAR)}/role`,
      { role: 'owner' },
    );
    expect(res.status).toBe(200);
    expect((await roster())[REGULAR]).toBe('owner');
    // …and back, by the operator, so the rest of this file reads a Regular
    // User where it expects one.
    expect(
      (
        await postLocal(
          `/workspaces/${encodeURIComponent(board)}/members/${encodeURIComponent(REGULAR)}/role`,
          { role: 'member' },
        )
      ).status,
    ).toBe(200);
    expect((await roster())[REGULAR]).toBe('member');
  });

  it('refuses a level that is not one of the two words', async () => {
    const res = await postLocal(
      `/workspaces/${encodeURIComponent(board)}/members/${encodeURIComponent(REGULAR)}/role`,
      { role: 'admin' },
    );
    expect(res.status).toBe(400);
    expect((await roster())[REGULAR]).toBe('member');
  });

  it('refuses a Regular User’s answer to an owner-only ask, and the ask stays open', async () => {
    const res = await postAsVisitor(
      REGULAR,
      `/workspaces/${encodeURIComponent(board)}/tasks/${taskId}/review-items/${gatedItem}/answer`,
      { text: 'Go ahead', answeredWith: 'o-yes' },
    );
    expect(res.status).toBe(403);
    // The refusal has to be a refusal to WRITE. The answer route converts an
    // un-tapped answer into an ask-back before it records anything, so a gate
    // placed after that would refuse a board that had already changed.
    const still = (await itemsOnTask()).find((i) => i.id === gatedItem);
    expect(still?.answer).toBeUndefined();
  });

  it('leaves every other ask answerable by a Regular User', async () => {
    // The flag is opt-in and default-absent: gating an item is a decision
    // somebody made about that item, never a new floor under the board.
    const res = await postAsVisitor(
      REGULAR,
      `/workspaces/${encodeURIComponent(board)}/tasks/${taskId}/review-items/${openItem}/answer`,
      { text: 'Leave it', answeredWith: 'o-no' },
    );
    expect(res.status).toBe(200);
    const answered = (await itemsOnTask()).find((i) => i.id === openItem);
    expect(answered?.answer?.text).toBe('Leave it');
  });

  it('refuses a Regular User’s other writes onto an owner-only ask', async () => {
    // Answering is not the only way to drive an ask. A revision rewrites the
    // question the owner acts on, a withdrawal takes it off their queue, a
    // question posted where the answer goes files on its thread, and a release
    // overrules the gate holding it. Every one of those is the owner's.
    const at = (verb: string) =>
      `/workspaces/${encodeURIComponent(board)}/tasks/${taskId}/review-items/${gatedItem}/${verb}`;
    const refusals = await Promise.all([
      postAsVisitor(REGULAR, at('more-info'), { question: 'Which index?' }),
      postAsVisitor(REGULAR, at('revise'), { headline: 'Reworded by a Regular User' }),
      postAsVisitor(REGULAR, at('release'), {}),
      postAsVisitor(REGULAR, at('withdraw'), { reason: 'not mine' }),
    ]);
    expect(refusals.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    // Status codes are half of it: a refusal that still wrote is a 403 on a
    // board that changed. The ask is word-for-word the one the agent filed,
    // and it is still on the owner's queue.
    const still = await jj<{
      tasks: Array<{
        id: string;
        reviews?: Array<{ id: string; review?: { headline?: string; withdrawnAt?: number } }>;
      }>;
    }>(await local(`/workspaces/${encodeURIComponent(board)}/tasks?format=json`));
    const item = still.tasks.find((t) => t.id === taskId)?.reviews?.find((r) => r.id === gatedItem);
    expect(item?.review?.headline).toBe('Run the reindex command on this machine?');
    expect(item?.review?.withdrawnAt).toBeUndefined();
  });

  it('refuses a Regular User’s answer to an owner-only ask raised on a DOC THREAD', async () => {
    // The flag belongs to the ASK, not to the surface it was filed on. The
    // same question reaches a person as a row on a ticket or as a thread on a
    // doc, and the doc thread has its own answer door.
    const dir = mkdtempSync(join(tmpdir(), 'board-roles-doc-'));
    const file = join(dir, 'relay-plan.md');
    writeFileSync(file, '# Relay plan\n\nThe nightly reindex runs on the operator machine.\n');
    const docId = 'relay-plan';
    expect(
      (
        await postLocal(`/workspaces/${encodeURIComponent(board)}/docs`, {
          docId,
          type: 'markdown',
          sourceUrl: file,
          owner: dir,
          title: 'Relay plan',
        })
      ).status,
    ).toBe(200);
    const thread = await jj<{
      thread: { id: string; comments: Array<{ id: string }> };
    }>(
      await postLocal(
        `/workspaces/${encodeURIComponent(board)}/docs/${encodeURIComponent(docId)}/threads/by_find`,
        {
          author: { id: 'a-relay', name: 'Relay Bot', kind: 'agent' },
          find: 'nightly reindex',
          text: 'Shall I run the reindex command on this machine?',
          review: {
            shape: 'decision',
            headline: 'Run the reindex command on this machine?',
            detail: 'It rewrites the index in place on the operator machine.',
            options: [
              { id: 'o-yes', label: 'Go ahead' },
              { id: 'o-no', label: 'Leave it' },
            ],
            ownerOnly: true,
          },
        },
      ),
    );
    const threadId = thread.thread.id;
    const commentId = thread.thread.comments[0]?.id ?? '';
    const answerPath = `/workspaces/${encodeURIComponent(board)}/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/answer`;
    expect(
      (
        await postAsVisitor(REGULAR, answerPath, {
          text: 'Go ahead',
          optionId: 'o-yes',
          commentId,
        })
      ).status,
    ).toBe(403);
    // A plain reply is the other answer door — it folds into the answer when
    // it lands on a pending ask — so it takes the same gate.
    expect(
      (
        await postAsVisitor(
          REGULAR,
          `/workspaces/${encodeURIComponent(board)}/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/comments`,
          { text: 'Go ahead' },
        )
      ).status,
    ).toBe(403);
    const after = await jj<{
      thread: { comments: Array<{ review?: { answeredAt?: number } }> };
    }>(
      await local(
        `/workspaces/${encodeURIComponent(board)}/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}`,
      ),
    );
    expect(after.thread.comments[0]?.review?.answeredAt).toBeUndefined();
    // And the Owner's answer lands on the same door.
    expect(
      (
        await postAsVisitor(PROMOTED, answerPath, {
          text: 'Go ahead',
          optionId: 'o-yes',
          commentId,
        })
      ).status,
    ).toBe(200);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('lets an Owner answer the owner-only ask', async () => {
    const res = await postAsVisitor(
      PROMOTED,
      `/workspaces/${encodeURIComponent(board)}/tasks/${taskId}/review-items/${gatedItem}/answer`,
      { text: 'Go ahead', answeredWith: 'o-yes' },
    );
    expect(res.status).toBe(200);
    const answered = (await itemsOnTask()).find((i) => i.id === gatedItem);
    expect(answered?.answer?.text).toBe('Go ahead');
  });

  it('refuses a Regular User’s change to the board’s settings, and the settings do not move', async () => {
    // Every field this PUT can move is board-wide configuration — the words
    // every agent's ask on this board is judged against, and how many builders
    // a dispatch may run at once. A guest is invited to WORK the board, not to
    // retune the rules the rest of it runs by.
    const before = await boardSettings();
    const guest = { id: 'u-guest', name: 'Keeper', kind: 'human' };
    const refusals = await Promise.all([
      putAsVisitor(REGULAR, `/workspaces/${encodeURIComponent(board)}/settings`, {
        reviewItemCriteria: 'Anything at all counts as a good ask.',
        author: guest,
      }),
      putAsVisitor(REGULAR, `/workspaces/${encodeURIComponent(board)}/settings`, {
        parallelismCap: 9,
        author: guest,
      }),
    ]);
    expect(refusals.map((r) => r.status)).toEqual([403, 403]);
    // A 403 that still wrote is the failure this is guarding: read the board
    // back rather than trusting the status.
    expect(await boardSettings()).toEqual(before);
  });

  it('leaves the same settings readable to a Regular User, and writable by an Owner', async () => {
    // The read is everyone's: a criterion you cannot read is one your agents
    // are judged against in secret.
    const read = await jj<{
      reviewItemCriteria: { value: string };
      parallelismCap: { value: number };
      notesHome?: unknown;
    }>(await asVisitor(REGULAR, `/workspaces/${encodeURIComponent(board)}/settings`));
    expect(read.reviewItemCriteria.value.length).toBeGreaterThan(0);
    // …minus the one field that is a path on the operator's machine.
    expect(read.notesHome).toBeUndefined();
    // And the gate is the ROLE, not the hostname: the promoted guest writes.
    const res = await putAsVisitor(PROMOTED, `/workspaces/${encodeURIComponent(board)}/settings`, {
      parallelismCap: 5,
      author: { id: 'u-pilot', name: 'Pilot', kind: 'human' },
    });
    expect(res.status).toBe(200);
    expect((await boardSettings()).cap).toBe(5);
    // notesHome stays refused even for them — it is not about the board.
    const home = await putAsVisitor(
      PROMOTED,
      `/workspaces/${encodeURIComponent(board)}/settings`,
      { notesHome: null, author: { id: 'u-pilot', name: 'Pilot', kind: 'human' } },
    );
    expect(home.status).toBe(403);
  });

  it('ends a person’s access when the Owner says so', async () => {
    const res = await local(
      `/workspaces/${encodeURIComponent(board)}/members/${encodeURIComponent(REGULAR)}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    expect(await roster()).toEqual({ [PROMOTED]: 'owner' });
    // And the board is closed to them from the next request on.
    const after = await asVisitor(REGULAR, `/workspaces/${encodeURIComponent(board)}?format=json`);
    expect(after.status).toBe(403);
  });
});
