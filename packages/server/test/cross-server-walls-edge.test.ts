/**
 * No board server accepts a credential that Cloudflare Access or a vendor
 * issued for another board server.
 *
 * The credentials the server signs itself, and the full list of every type
 * a server issues or accepts, are in `cross-server-walls.test.ts`. This file
 * holds the ones another party signs, where what keeps two servers apart is
 * a per-server setting: an Access audience, a service token client id, a
 * share record, a webhook secret.
 *
 * Two real servers, Harborlight and Riverbend, configured as two orgs would
 * be on one Cloudflare account: the same Access team domain and the same
 * signing keys (the hard case, since only the audience then tells two
 * stamps apart), and for each server its own owner hostname, collaboration
 * hostname, share hostname and vendor callback hostname, each behind its own
 * Access application. The owner's address is the same on both, so a refusal
 * is never just "unknown person". All Access stamps are signed here with a
 * key made for this run; every secret is a literal made up for this file.
 *
 * Each type is checked in both directions: the issuer accepts the value on
 * its own route (the control), and the other server refuses it on the same
 * route while accepting its own value there (the second control).
 *
 *  - Access stamp, person: the owner on the owner hostname.
 *  - Access stamp, service token: the home feed pull (`routes/home-feed.ts`)
 *    and the relay's `at2` over the tunnel (`middleware/board-agent-door.ts`).
 *  - Share-link invitation (`/s/<id>`, `share/share-links.ts`), and the
 *    membership its redemption records.
 *  - Collaboration share (`POST /api/share/link`, minted here against the
 *    stand-in Cloudflare client), seen by a collaborator on the
 *    collaboration hostname.
 *  - Recall webhook signature (`recall-webhook-auth.ts`), per-server secret.
 *  - Setup 4's ElevenLabs secret (`routes/voice-agent-llm.ts`). The control
 *    is the route's next refusal (404 `unknown_session`, after the secret
 *    check passed), because a full answer needs an open mic session.
 *    Its per-conversation token is not covered: it lives only in the
 *    process that opened the mic socket, and minting one needs that session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { VOICE_AGENT_LLM_PATH } from '../src/spoken-reply/agent-llm.ts';
import { createElevenLabsAgent } from '../src/spoken-reply/elevenlabs-agent.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'cross-server-kid';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const OWNER_EMAIL = 'owner@example.test';
/** One guest per direction, so a member made in one is not reused. */
const GUESTS = {
  'Harborlight → Riverbend': 'alice@partner.example',
  'Riverbend → Harborlight': 'bob@partner.example',
};
const AGENT = 'agent-saltmarsh';

interface Org {
  name: string;
  handle: ServerHandle;
  dataDir: string;
  board: string;
  hosts: { owner: string; collab: string; share: string; callback: string };
  aud: { owner: string; collab: string; share: string };
  feedClientId: string;
  webhookSecret: string;
  llmSecret: string;
}

let sign: (aud: string, claims: Record<string, unknown>) => Promise<string>;
let jwks: JSONWebKeySet;
let harborlight: Org;
let riverbend: Org;

/** A request to `org`'s server naming `host`, as the tunnel delivers one. */
const at = (org: Org, host: string, path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${org.handle.port}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { host, ...CF_RAY, ...((init.headers as Record<string, string>) ?? {}) },
  });

/** From `org`'s own machine: loopback, no edge. */
const local = (org: Org, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${org.handle.port}${path}`, {
    method: 'POST',
    headers: { host: `localhost:${org.handle.port}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const stamp = (jwt: string) => ({ 'cf-access-jwt-assertion': jwt });

/**
 * `shareLinks: false` leaves the share hostname out: a server with one
 * refuses to mint the older collaboration share (410), so the
 * collaboration pair is booted without it.
 */
async function boot(name: string, shareLinks = true): Promise<Org> {
  const x = name.toLowerCase();
  const dataDir = mkdtempSync(join(tmpdir(), `walls-edge-${x}-`));
  const hosts = {
    owner: `${x}.example.test`,
    collab: `collab.${x}.example.test`,
    share: `share.${x}.example.test`,
    callback: `callback.${x}.example.test`,
  };
  const aud = { owner: `aud-${x}-owner`, collab: `aud-${x}-collab`, share: `aud-${x}-share` };
  const llmSecret = `fixture-llm-secret-${x}-0123456789abcdef`;
  const handle = createServer({
    port: 0,
    dataDir,
    cfAccess: {
      teamDomain: TEAM_DOMAIN,
      audience: aud.owner,
      hostAudiences: new Map([[hosts.collab, aud.collab]]),
      jwks,
    },
    proxiedTrustedHosts: [hosts.owner],
    proxiedTrustedEmails: [OWNER_EMAIL],
    accessTunnelHosts: [hosts.collab],
    ...(shareLinks ? { shareLinkHosts: [hosts.share], shareLinkAudience: aud.share } : {}),
    share: {
      config: { ...ACCESS_SHARE_CONFIG, publicHostname: `links.${x}.example.test` },
      cfApi: mockCfApi(),
    },
    homeFeedClientId: `feed-${x}.access`,
    recallCallbackHost: hosts.callback,
    meetingBotWebhookSecret: `whsec_${btoa(`cross-server-${x}`)}`,
    spokenReply: {
      listener: null,
      voices: { 1: null, 2: null },
      gemini: null,
      agent: {
        live: createElevenLabsAgent({
          apiKey: 'placeholder-key',
          agentId: `agent_${x}`,
          socketFactory: () => ({ send: () => {}, close: () => {} }),
        }),
        llmSecret,
      },
    },
  });
  const org = {
    name,
    handle,
    dataDir,
    board: '',
    hosts,
    aud,
    feedClientId: `feed-${x}.access`,
    webhookSecret: `whsec_${btoa(`cross-server-${x}`)}`,
    llmSecret,
  };
  const made = await local(org, '/workspaces', { name: `${name} board` });
  expect(made.status).toBe(200);
  org.board = ((await made.json()) as { workspace: { id: string } }).workspace.id;
  // The guest's domain is on the board's audience, so both a share link and
  // a collaboration share may name them.
  handle.shareLinks.addToAudience(org.board, ['@partner.example'], 'Bryan');
  return org;
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwks = { keys: [jwk] };
  sign = (aud, claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(privateKey);
  harborlight = await boot('Harborlight');
  riverbend = await boot('Riverbend');
});

afterAll(async () => {
  for (const org of [harborlight, riverbend]) {
    await org.handle.stop();
    rmSync(org.dataDir, { recursive: true, force: true });
  }
});

const DIRECTIONS = ['Harborlight → Riverbend', 'Riverbend → Harborlight'] as const;
const pair = (d: (typeof DIRECTIONS)[number]): [Org, Org] =>
  d === DIRECTIONS[0] ? [harborlight, riverbend] : [riverbend, harborlight];

const boardJson = (org: Org) => `/workspaces/${org.board}?format=json`;

describe("the owner's Access stamp", () => {
  for (const d of DIRECTIONS) {
    it(d, async () => {
      const [issuer, other] = pair(d);
      const jwt = await sign(issuer.aud.owner, { email: OWNER_EMAIL });
      const own = await sign(other.aud.owner, { email: OWNER_EMAIL });
      expect(
        (await at(issuer, issuer.hosts.owner, boardJson(issuer), { headers: stamp(jwt) })).status,
      ).toBe(200);
      expect(
        (await at(other, other.hosts.owner, boardJson(other), { headers: stamp(own) })).status,
      ).toBe(200);
      expect(
        (await at(other, other.hosts.owner, boardJson(other), { headers: stamp(jwt) })).status,
      ).toBe(401);
    });
  }
});

describe("the home feed's service token stamp", () => {
  for (const d of DIRECTIONS) {
    it(d, async () => {
      const [issuer, other] = pair(d);
      const feed = (org: Org) => `/workspaces/${org.board}/home-feed`;
      const jwt = await sign(issuer.aud.owner, { common_name: issuer.feedClientId });
      const own = await sign(other.aud.owner, { common_name: other.feedClientId });
      // Another org's client id under this org's own audience.
      const otherId = await sign(other.aud.owner, { common_name: issuer.feedClientId });
      expect(
        (await at(issuer, issuer.hosts.owner, feed(issuer), { headers: stamp(jwt) })).status,
      ).toBe(200);
      expect(
        (await at(other, other.hosts.owner, feed(other), { headers: stamp(own) })).status,
      ).toBe(200);
      expect(
        (await at(other, other.hosts.owner, feed(other), { headers: stamp(jwt) })).status,
      ).not.toBe(200);
      expect(
        (await at(other, other.hosts.owner, feed(other), { headers: stamp(otherId) })).status,
      ).not.toBe(200);
    });
  }
});

describe("the relay's board token over the tunnel, with a service token stamp", () => {
  for (const d of DIRECTIONS) {
    it(d, async () => {
      const [issuer, other] = pair(d);
      const mint = async (org: Org) => {
        const res = await local(org, '/api/board-tokens', { agentId: AGENT, boardId: org.board });
        expect(res.status, await res.clone().text()).toBe(201);
        return ((await res.json()) as { token: string }).token;
      };
      const refresh = async (org: Org, token: string, aud: string) =>
        (
          await at(org, org.hosts.owner, '/api/board-tokens/refresh', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              ...stamp(await sign(aud, { common_name: `relay-${org.name.toLowerCase()}.access` })),
            },
          })
        ).status;
      const issued = await mint(issuer);
      expect(await refresh(issuer, issued, issuer.aud.owner)).toBe(200);
      expect(await refresh(other, await mint(other), other.aud.owner)).toBe(200);
      // A valid stamp for the other server's own application: only the
      // token is foreign.
      expect(await refresh(other, issued, other.aud.owner)).toBe(401);
      // And the issuer's stamp with it.
      expect(await refresh(other, issued, issuer.aud.owner)).toBe(401);
    });
  }
});

describe('a share-link invitation, and the membership it records', () => {
  for (const d of DIRECTIONS) {
    it(d, async () => {
      const [issuer, other] = pair(d);
      const mint = async (org: Org) => {
        const res = await local(org, '/api/share/workspace', { workspaceId: org.board });
        expect(res.status, await res.clone().text()).toBe(200);
        return ((await res.json()) as { link: { linkId: string } }).link.linkId;
      };
      const onShare = async (org: Org, path: string, aud: string) =>
        (
          await at(org, org.hosts.share, path, {
            headers: stamp(await sign(aud, { email: GUESTS[d] })),
          })
        ).status;
      const link = await mint(issuer);
      expect(await onShare(issuer, `/s/${link}`, issuer.aud.share)).toBe(302);
      expect(await onShare(issuer, boardJson(issuer), issuer.aud.share)).toBe(200);
      // The other server: its own share stamp, the issuer's link id.
      expect(await onShare(other, `/s/${link}`, other.aud.share)).toBe(404);
      // The issuer's share stamp on the other server's share hostname.
      expect(await onShare(other, `/s/${link}`, issuer.aud.share)).toBe(401);
      // The redemption made a member on the issuer only.
      expect(await onShare(other, boardJson(other), other.aud.share)).toBe(403);
      // CONTROL: the other server's own link admits the same guest there.
      expect(await onShare(other, `/s/${await mint(other)}`, other.aud.share)).toBe(302);
      expect(await onShare(other, boardJson(other), other.aud.share)).toBe(200);
    });
  }
});

describe('a collaboration share, seen on the collaboration hostname', () => {
  const orgs: Org[] = [];
  beforeAll(async () => {
    orgs.push(await boot('Harborlight', false), await boot('Riverbend', false));
    for (const org of orgs) {
      const res = await local(org, '/api/share/link', {
        workspaceId: org.board,
        allowDomains: ['@partner.example'],
      });
      expect(res.status, await res.clone().text()).toBe(200);
    }
  });
  afterAll(async () => {
    for (const org of orgs) {
      await org.handle.stop();
      rmSync(org.dataDir, { recursive: true, force: true });
    }
  });

  for (const d of DIRECTIONS) {
    it(d, async () => {
      const [issuer, other] = d === DIRECTIONS[0] ? [orgs[0]!, orgs[1]!] : [orgs[1]!, orgs[0]!];
      const onCollab = async (org: Org, aud: string) =>
        (
          await at(org, org.hosts.collab, boardJson(org), {
            headers: stamp(await sign(aud, { email: GUESTS[d] })),
          })
        ).status;
      expect(await onCollab(issuer, issuer.aud.collab)).toBe(200);
      expect(await onCollab(other, other.aud.collab)).toBe(200);
      expect(await onCollab(other, issuer.aud.collab)).toBe(401);
    });
  }
});

/** Svix headers for `body` under `secret`, signed the way Recall signs. */
async function svix(secret: string, body: string, id: string): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(secret.slice('whsec_'.length)), (c) =>
      c.charCodeAt(0),
    ) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${btoa(String.fromCharCode(...mac))}`,
  };
}

describe('a Recall webhook signature', () => {
  let seq = 0;
  const BODY = JSON.stringify({
    event: 'bot.done',
    data: { bot: { id: 'bot_fixture_1' }, data: { code: 'done' } },
  });
  const deliver = async (org: Org, secret: string) =>
    (
      await at(org, org.hosts.callback, '/recall/status', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(await svix(secret, BODY, `msg_walls_${String(++seq).padStart(4, '0')}`)),
        },
        body: BODY,
      })
    ).status;

  for (const d of DIRECTIONS) {
    it(d, async () => {
      const [issuer, other] = pair(d);
      expect(await deliver(issuer, issuer.webhookSecret)).toBe(200);
      expect(await deliver(other, other.webhookSecret)).toBe(200);
      expect(await deliver(other, issuer.webhookSecret)).toBe(401);
    });
  }
});

describe("setup 4's ElevenLabs secret", () => {
  const ask = async (org: Org, secret: string) =>
    (
      await at(org, org.hosts.callback, VOICE_AGENT_LLM_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          model: 'claude-workspaces',
          stream: true,
          messages: [{ role: 'user', content: 'status' }],
          elevenlabs_extra_body: { cw_session: '0'.repeat(32) },
        }),
      })
    ).status;

  for (const d of DIRECTIONS) {
    it(d, async () => {
      const [issuer, other] = pair(d);
      // Past the secret, refused only for naming no open session.
      expect(await ask(issuer, issuer.llmSecret)).toBe(404);
      expect(await ask(other, other.llmSecret)).toBe(404);
      expect(await ask(other, issuer.llmSecret)).toBe(401);
    });
  }
});
