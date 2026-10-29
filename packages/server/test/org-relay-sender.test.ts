/**
 * Who the relay believes sent a message, across two real board servers.
 *
 * The relay takes the sender to be the seat whose outbox a thread is on, and
 * only when the thread's author, as the SERVER recorded it, is that seat's
 * agent. So the sender check is only as good as the server's attribution.
 * This drives the two callers that could claim a lead's agent id in a body:
 *
 *  - a person who is a member of the lead's board, coming through the tunnel
 *    with their own Access identity (a share link redeemed, then a stamp from
 *    the share application), and
 *  - an agent holding an `at2` of its own on the same board, and
 *  - a caller on the server's own machine, over loopback with no token at
 *    all. The server still records the author that caller claims, since
 *    loopback is trusted-local; the relay must not take that as the seat.
 *
 * All three post `author: <the lead's agent>` on the lead's outbox. The positive
 * control is the lead itself, posting with its own `at2`: that message
 * crosses to the other organization's server. Every key here is made in the
 * test, and the email is assembled at runtime rather than written down.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type RelayConfig, parseRelayConfig } from '../src/org-relay/relay-config.ts';
import { createRelayStore } from '../src/org-relay/relay-log.ts';
import { createRelay } from '../src/org-relay/relay.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'org-relay-sender-kid';
const SHARE_AUD = 'aud-for-the-share-app';
const OWNER_AUD = 'aud-for-the-owner-app';
const SHARE_HOST = 'share.harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const MEMBER = ['keeper', 'harborlight.test'].join('@');
const LEAD = 'agent-harborlight-lead';
const WRITER = 'agent-harborlight-writer';
const RELAY_AGENT = 'agent-relay-harborlight';

interface ThreadRow {
  id: string;
  createdBy: { id: string; kind?: string };
  comments: Array<{ author: { id: string }; text: string }>;
  openerProof?: { kind: string; agentId: string; boardId: string };
}

describe('the relay’s sender check holds against a forged author', () => {
  const dirs: string[] = [];
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  let harbor: ServerHandle;
  let river: ServerHandle;
  let harborBoard = '';
  let riverBoard = '';
  let outbox = '';
  let riverInbox = '';
  let config: RelayConfig;
  let stamp: () => Promise<string>;
  const tokens = new Map<string, string>();

  const base = (h: ServerHandle) => `http://127.0.0.1:${h.port}`;
  const post = async (
    h: ServerHandle,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    want = 200,
  ) => {
    const res = await fetch(`${base(h)}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(want);
    return (await res.json()) as Record<string, unknown>;
  };
  const threads = async (h: ServerHandle, board: string, doc: string): Promise<ThreadRow[]> => {
    const res = await fetch(`${base(h)}/workspaces/${board}/docs/${doc}/threads`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { threads: ThreadRow[] }).threads;
  };
  const allText = (rows: ThreadRow[]) =>
    rows.flatMap((t) => t.comments.map((c) => c.text)).join('\n');
  /** A thread on the lead's outbox, every body naming the lead as author. */
  const postToOutbox = async (text: string, headers: Record<string, string>) =>
    (
      (await post(
        harbor,
        `/workspaces/${harborBoard}/docs/${outbox}/threads`,
        {
          author: { id: LEAD, name: 'harborlight-lead', kind: 'agent' },
          text: `to: riverbend-lead\n${text}`,
          anchor: { kind: 'subject' },
        },
        headers,
      )) as { thread: ThreadRow }
    ).thread;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = (await exportJWK(publicKey)) as JWK;
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const jwks: JSONWebKeySet = { keys: [jwk] };
    stamp = () =>
      new SignJWT({ email: MEMBER })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(SHARE_AUD)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setSubject('cf-access-org-relay-sender')
        .sign(privateKey);
    harbor = createServer({
      port: 0,
      dataDir: tmp('relay-sender-harbor-'),
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    });
    river = createServer({ port: 0, dataDir: tmp('relay-sender-river-') });
    const setup = { id: 'agent-setup', name: 'setup', kind: 'agent' };
    const board = async (h: ServerHandle, name: string) =>
      ((await post(h, '/workspaces', { name, author: setup })) as { workspace: { id: string } })
        .workspace.id;
    const task = async (h: ServerHandle, b: string, title: string) =>
      `task:${((await post(h, `/workspaces/${b}/tasks`, { title, author: setup })) as { task: { id: string } }).task.id}`;
    const mint = async (h: ServerHandle, b: string, agentId: string) => {
      const res = (await post(
        h,
        '/api/board-tokens',
        { agentId, boardId: b, label: 'relay sender test' },
        {},
        201,
      )) as { token: string };
      tokens.set(`${h.port}/${agentId}`, res.token);
      return res.token;
    };
    harborBoard = await board(harbor, 'Harborlight board');
    riverBoard = await board(river, 'Riverbend board');
    outbox = await task(harbor, harborBoard, 'Outbox for harborlight-lead');
    riverInbox = await task(river, riverBoard, 'Inbox for riverbend-lead');
    await mint(harbor, harborBoard, LEAD);
    await mint(harbor, harborBoard, WRITER);

    // The member: a share link to the board, redeemed through the tunnel.
    harbor.shareLinks.addToAudience(harborBoard, [MEMBER], 'Bryan');
    const link = (await post(harbor, '/api/share/workspace', { workspaceId: harborBoard })) as {
      link: { linkId: string };
    };
    const redeemed = await fetch(`${base(harbor)}/s/${link.link.linkId}`, {
      redirect: 'manual',
      headers: { host: SHARE_HOST, ...CF_RAY, 'cf-access-jwt-assertion': await stamp() },
    });
    expect(redeemed.status).toBe(302);

    const parsed = parseRelayConfig(
      JSON.stringify({
        servers: {
          harbor: {
            organization: 'harborlight',
            baseUrl: base(harbor),
            bearers: { [harborBoard]: await mint(harbor, harborBoard, RELAY_AGENT) },
          },
          river: {
            organization: 'riverbend',
            baseUrl: base(river),
            bearers: { [riverBoard]: await mint(river, riverBoard, RELAY_AGENT) },
          },
        },
        seats: {
          'harborlight-lead': {
            server: 'harbor',
            board: harborBoard,
            agentId: LEAD,
            outboxDoc: outbox,
            inboxDoc: await task(harbor, harborBoard, 'Inbox for harborlight-lead'),
            crossOrganization: true,
          },
          'riverbend-lead': {
            server: 'river',
            board: riverBoard,
            agentId: 'agent-riverbend-lead',
            outboxDoc: await task(river, riverBoard, 'Outbox for riverbend-lead'),
            inboxDoc: riverInbox,
            crossOrganization: true,
          },
        },
      }),
    );
    if ('error' in parsed) throw new Error(parsed.error);
    config = parsed;
  });

  afterAll(async () => {
    await harbor?.stop();
    await river?.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('carries only the message the lead posted with its own token', async () => {
    const store = createRelayStore(tmp('relay-sender-state-'));
    const relay = createRelay({
      config,
      store,
      filter: async () => ({ hold: false }),
      log: () => {},
    });

    // A board member through the tunnel, with their own Access identity.
    const fromMember = await postToOutbox('Sent by the member as the lead.', {
      host: SHARE_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': await stamp(),
    });
    // Another agent on the board, with an at2 of its own.
    const fromWriter = await postToOutbox('Sent by the writer as the lead.', {
      authorization: `Bearer ${tokens.get(`${harbor.port}/${WRITER}`)}`,
    });
    // A caller on this machine, over loopback, presenting no token.
    const fromLoopback = await postToOutbox('Sent from loopback as the lead.', {});
    // The control: the lead, with its own at2.
    const fromLead = await postToOutbox('Sent by the lead itself.', {
      authorization: `Bearer ${tokens.get(`${harbor.port}/${LEAD}`)}`,
    });

    // The server recorded each caller as who it proved to be, not the body.
    expect(fromMember.createdBy.id).not.toBe(LEAD);
    expect(fromMember.createdBy.kind).not.toBe('agent');
    expect(fromWriter.createdBy.id).toBe(WRITER);
    expect(fromLead.createdBy.id).toBe(LEAD);
    // Loopback is trusted-local, so the claimed author stands on the thread.
    // The relay has to tell this one from the lead's own by something else.
    expect(fromLoopback.createdBy.id).toBe(LEAD);
    // Only the lead's own token left the server's opener proof.
    const proofs = new Map(
      (await threads(harbor, harborBoard, outbox)).map((t) => [t.id, t.openerProof ?? null]),
    );
    expect(proofs.get(fromLead.id)).toEqual({
      kind: 'board-token',
      agentId: LEAD,
      boardId: harborBoard,
    });
    expect(proofs.get(fromLoopback.id)).toBeNull();
    expect(proofs.get(fromMember.id)).toBeNull();
    expect(proofs.get(fromWriter.id)?.agentId).toBe(WRITER);

    await relay.pollOnce();
    const delivered = allText(await threads(river, riverBoard, riverInbox));
    expect(delivered).toContain('> Sent by the lead itself.');
    expect(delivered).not.toContain('Sent by the member');
    expect(delivered).not.toContain('Sent by the writer');
    expect(delivered).not.toContain('Sent from loopback');
    const ids = new Set(store.entries().map((e) => e.id));
    expect(ids.has(`harborlight-lead:${fromLead.id}`)).toBe(true);
    expect(ids.has(`harborlight-lead:${fromMember.id}`)).toBe(false);
    expect(ids.has(`harborlight-lead:${fromWriter.id}`)).toBe(false);
    expect(ids.has(`harborlight-lead:${fromLoopback.id}`)).toBe(false);
  });
});
