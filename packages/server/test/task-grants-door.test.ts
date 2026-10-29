/**
 * A grant card, end to end through the real admission gate: filed by an
 * agent, refused to every caller but the owner's own browser, written into a
 * settings file on Approve, and taken back out when the task closes.
 *
 * The settings file is a temp file handed to the server as
 * `permissionSettingsPath` — no real settings file is named or opened. The
 * owner is proven the way prod proves them off the box: a Cloudflare Access
 * assertion on the owner hostname for the configured owner email. The
 * harness is `board-lock.test.ts`'s.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'grant-door-kid';
const SHARE_AUD = 'aud-share-app';
const OWNER_AUD = 'aud-owner-app';
const SHARE_HOST = 'share.harborlight.test';
const OWNER_HOST = 'workspaces.harborlight.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const MEMBER = 'bob@riverbend.example';
const OWNER_EMAIL = 'owner@harborlight.test';

/** What the board's own page sends with a press of Approve. */
const SAME_ORIGIN = { origin: `https://${OWNER_HOST}`, 'sec-fetch-site': 'same-origin' };

const AGENT = { id: 'agent-riverbend', name: 'Riverbend Bot', kind: 'agent' as const };
/** What an agent would claim to be if it tried to pass as the owner. */
const CLAIMS_OWNER = { id: 'known-bryan', name: 'Bryan', kind: 'known' as const };

const PUSH = 'Bash(git push --force-with-lease:*)';
const TAG = 'Bash(git tag:*)';
const OWN = 'Bash(git status:*)';

const ORIGINAL = `${JSON.stringify(
  {
    permissions: { allow: [OWN], deny: ['Bash(rm -rf:*)'], ask: ['Bash(git push:*)'] },
    env: { HARBORLIGHT_MODE: 'quiet' },
  },
  null,
  2,
)}\n`;

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
      .setSubject('cf-access-grant-door')
      .sign(privateKey);
});

describe('a grant card, answered only by the owner in the browser', () => {
  let handle: ServerHandle;
  let root: string;
  let settings: string;
  let base: string;
  let board: string;
  let taskId: string;
  let itemId: string;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });
  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  /** An agent, or anything else on this machine: loopback, no proof. */
  const postLocal = (path: string, body: unknown) =>
    req(path, `localhost:${handle.port}`, json(body));
  /** The owner's own browser, off the box: Access proved the owner email,
   *  and the browser says the request came from the board's own page. */
  const postOwner = async (
    path: string,
    body: unknown,
    browser: Record<string, string> = SAME_ORIGIN,
  ) =>
    req(path, OWNER_HOST, {
      ...json(body),
      headers: {
        'content-type': 'application/json',
        ...CF_RAY,
        'x-forwarded-proto': 'https',
        'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL),
        ...browser,
      },
    });
  const postMember = async (path: string, body: unknown) =>
    req(path, SHARE_HOST, {
      ...json(body),
      headers: {
        'content-type': 'application/json',
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(SHARE_AUD, MEMBER),
      },
    });
  const scope = () => `/workspaces/${encodeURIComponent(board)}`;
  const grantPath = () => `${scope()}/tasks/${taskId}/review-items/${itemId}/grant`;
  const settingsNow = () => readFileSync(settings, 'utf8');

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'grant-door-'));
    settings = join(root, 'settings.json');
    writeFileSync(settings, ORIGINAL);
    handle = createServer({
      port: 0,
      dataDir: join(root, 'data'),
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      ownerEmail: OWNER_EMAIL,
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      permissionSettingsPath: settings,
    });
    base = `http://127.0.0.1:${handle.port}`;
    board = (
      (await (await postLocal('/workspaces', { name: 'Harborlight release' })).json()) as {
        workspace: { id: string };
      }
    ).workspace.id;
    // A share member on this board, so the member door is a real one.
    handle.shareLinks.addToAudience(board, [MEMBER], 'Bryan');
    const link = (await (
      await postLocal('/api/share/workspace', { workspaceId: board })
    ).json()) as { link: { linkId: string } };
    const redeemed = await req(`/s/${link.link.linkId}`, SHARE_HOST, {
      headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, MEMBER) },
    });
    expect(redeemed.status).toBe(302);
    taskId = (
      (await (
        await postLocal(`${scope()}/tasks`, {
          title: 'Rebuild and retag the Harborlight release branch',
          body: 'Agent can force-push the rebuilt branch so that the release tag points at it.',
          author: AGENT,
        })
      ).json()) as { task: { id: string } }
    ).task.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
    resetOwnerIdentities();
  });

  it('files ONE card listing every command, before any work, and refuses bare Bash', async () => {
    const bare = await postLocal(`${scope()}/tasks/${taskId}/review-items`, {
      author: AGENT,
      review: { review_type: 'grant', headline: 'Allow everything', allowRules: ['Bash'] },
    });
    expect(bare.status).toBe(400);
    const res = await postLocal(`${scope()}/tasks/${taskId}/review-items`, {
      author: AGENT,
      review: {
        review_type: 'grant',
        headline: 'Allow the release commands until this task closes',
        detail: 'The rebuild force-pushes the branch and moves the release tag.',
        allowRules: [PUSH, TAG, OWN],
      },
    });
    expect(res.status).toBe(200);
    const { item } = (await res.json()) as {
      item: { id: string; review: { shape: string; allowRules: string[]; ownerOnly: boolean } };
    };
    expect(item.review.shape).toBe('grant');
    expect(item.review.allowRules).toEqual([PUSH, TAG, OWN]);
    expect(item.review.ownerOnly).toBe(true);
    itemId = item.id;
  });

  it('a share member may not file one', async () => {
    const res = await postMember(`${scope()}/tasks/${taskId}/review-items`, {
      author: { id: 'u-member', name: 'Bob', kind: 'human' },
      review: { review_type: 'grant', headline: 'Allow tags', allowRules: [TAG] },
    });
    expect(res.status).toBe(403);
  });

  it("refuses an agent's answer_review_item, and writes nothing", async () => {
    const res = await postLocal(`${scope()}/tasks/${taskId}/review-items/${itemId}/answer`, {
      author: AGENT,
      text: 'Approve',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('grant-item');
    expect(settingsNow()).toBe(ORIGINAL);
  });

  it('refuses the grant door to a loopback caller with no person proof, even one claiming the owner', async () => {
    for (const author of [AGENT, CLAIMS_OWNER]) {
      const res = await postLocal(grantPath(), {
        author,
        decision: 'approve',
        allowRules: [PUSH, TAG, OWN],
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('owner-proof-required');
    }
    expect(settingsNow()).toBe(ORIGINAL);
  });

  it('refuses the grant door to a share member', async () => {
    const res = await postMember(grantPath(), {
      decision: 'approve',
      allowRules: [PUSH, TAG, OWN],
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
    expect(settingsNow()).toBe(ORIGINAL);
  });

  it('refuses an approval of lines other than the ones the card holds', async () => {
    const res = await postOwner(grantPath(), { decision: 'approve', allowRules: [PUSH] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('card-changed');
    expect(settingsNow()).toBe(ORIGINAL);
  });

  it("refuses the owner's proof on a request that is not from the board's own page", async () => {
    // A page on another local port can carry the owner's session cookie; it
    // cannot make the browser say same-origin, or send this server's Origin.
    const variants: Array<Record<string, string>> = [
      {},
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site', origin: `https://${OWNER_HOST}` },
      { 'sec-fetch-site': 'same-origin' },
    ];
    for (const browser of variants) {
      const res = await postOwner(
        grantPath(),
        { decision: 'approve', allowRules: [PUSH, TAG, OWN] },
        browser,
      );
      expect(res.status, JSON.stringify(browser)).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('same-origin-only');
    }
    expect(settingsNow()).toBe(ORIGINAL);
  });

  it('404s a card reached through a board the task is not on', async () => {
    const other = (
      (await (await postLocal('/workspaces', { name: 'Saltmarsh notes' })).json()) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const res = await postOwner(
      `/workspaces/${encodeURIComponent(other)}/tasks/${taskId}/review-items/${itemId}/grant`,
      { decision: 'approve', allowRules: [PUSH, TAG, OWN] },
    );
    expect(res.status).toBe(404);
    expect(settingsNow()).toBe(ORIGINAL);
  });

  it("the owner's Approve adds exactly the listed lines and closes the card", async () => {
    const res = await postOwner(grantPath(), {
      decision: 'approve',
      allowRules: [PUSH, TAG, OWN],
    });
    expect(res.status).toBe(200);
    const after = JSON.parse(settingsNow());
    const before = JSON.parse(ORIGINAL);
    expect(after.permissions.allow).toEqual([OWN, PUSH, TAG]);
    expect(after.permissions.deny).toEqual(before.permissions.deny);
    expect(after.permissions.ask).toEqual(before.permissions.ask);
    expect(after.env).toEqual(before.env);
    const { item } = (await res.json()) as { item: { answer?: { text: string } } };
    expect(item.answer?.text).toContain(PUSH);
    // A second press finds it answered.
    const again = await postOwner(grantPath(), {
      decision: 'approve',
      allowRules: [PUSH, TAG, OWN],
    });
    expect(again.status).toBe(409);
  });

  it('closing the task takes back its lines and leaves every other byte unchanged', async () => {
    const res = await postLocal(`${scope()}/tasks/${taskId}/transition`, {
      author: AGENT,
      to: 'done',
    });
    expect(res.status).toBe(200);
    await waitFor(() => settingsNow() === ORIGINAL);
    expect(settingsNow()).toBe(ORIGINAL);
  });
  it("the owner's Decline closes the card and writes nothing", async () => {
    const other = (
      (await (
        await postLocal(`${scope()}/tasks`, {
          title: 'Retag the Riverbend build',
          body: 'Agent can move the build tag so that the Riverbend release names the right commit.',
          author: AGENT,
        })
      ).json()) as { task: { id: string } }
    ).task.id;
    const filed = (await (
      await postLocal(`${scope()}/tasks/${other}/review-items`, {
        author: AGENT,
        review: { review_type: 'grant', headline: 'Allow tags', allowRules: [TAG] },
      })
    ).json()) as { item: { id: string } };
    const res = await postOwner(`${scope()}/tasks/${other}/review-items/${filed.item.id}/grant`, {
      decision: 'decline',
      allowRules: [TAG],
    });
    expect(res.status).toBe(200);
    expect(settingsNow()).toBe(ORIGINAL);
  });

  it('refuses an Approve on a closed task before touching the settings', async () => {
    // Its lines would be written after the close already released the task,
    // so nothing would take them back until the next boot.
    const closed = (
      (await (
        await postLocal(`${scope()}/tasks`, {
          title: 'Tag the Saltmarsh build',
          body: 'Agent can tag the build so that the Saltmarsh release names the right commit.',
          author: AGENT,
        })
      ).json()) as { task: { id: string } }
    ).task.id;
    const filed = (await (
      await postLocal(`${scope()}/tasks/${closed}/review-items`, {
        author: AGENT,
        review: { review_type: 'grant', headline: 'Allow tags', allowRules: [TAG] },
      })
    ).json()) as { item: { id: string } };
    const archived = await postLocal(`${scope()}/tasks/${closed}/archive`, { author: AGENT });
    expect(archived.status).toBe(200);
    const res = await postOwner(`${scope()}/tasks/${closed}/review-items/${filed.item.id}/grant`, {
      decision: 'approve',
      allowRules: [TAG],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('task-closed');
    expect(settingsNow()).toBe(ORIGINAL);
  });
});
