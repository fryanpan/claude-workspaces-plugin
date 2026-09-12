/**
 * A secret ask, answered — and the value reaching nowhere but the store.
 *
 * The feature's whole claim is a NEGATIVE one, so this file is built to make
 * that claim falsifiable rather than vacuous. Every "it is not there" assertion
 * is paired with a control proving the value really did travel: the injected
 * writer records what it was handed, and the sweep that reads the data
 * directory is first shown finding a string that IS written there. A sweep that
 * can find nothing proves nothing.
 *
 * It drives the real route table behind a real Cloudflare Access fixture,
 * because the owner-only gate is wired in the admission layer: a route asserted
 * in isolation would pass while the gate never ran. The harness is
 * `board-roles.test.ts`'s.
 *
 * Every name here is invented and every value is a placeholder that is
 * deliberately not token-shaped. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { SecretWriteResult } from '../src/secret-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'secret-item-kid';
const SHARE_AUD = 'aud-for-the-share-app';
const OWNER_AUD = 'aud-for-the-owner-app';
const SHARE_HOST = 'share.example.test';
const OWNER_HOST = 'workspaces.example.test';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const REGULAR = 'reviewer@harborlight.example';
const OWNER_EMAIL = 'owner@example.test';

/** Two placeholders. Nothing here may read as a real value, anywhere. */
const FIRST_VALUE = 'not-a-real-value-1';
const SECOND_VALUE = 'not-a-real-value-2';

/** Emitted through `console.log` inside the capture window; see its use. */
const LOG_CONTROL = 'log-capture-control-line';

const AGENT = { id: 'a-riverbend', name: 'Riverbend Bot', kind: 'agent' as const };
const READER = { id: 'u-owner', name: 'Board Owner', kind: 'human' as const };

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
      .setSubject('cf-access-secret-item')
      .sign(privateKey);
});

describe('a secret ask, answered by the board owner', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let board: string;
  let taskId: string;
  let itemId: string;

  /** What the injected writer was handed, in order. */
  const written: Array<{ service: string; value: string }> = [];
  /** Every line this server logged while a request was in flight. */
  let logged: string[] = [];

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
  const postAsVisitor = async (email: string, path: string, body: unknown) =>
    req(path, SHARE_HOST, {
      method: 'POST',
      headers: {
        ...CF_RAY,
        'content-type': 'application/json',
        'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email),
      },
      body: JSON.stringify(body),
    });

  const jj = async <T>(res: Response): Promise<T> => {
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  const scope = () => `/workspaces/${encodeURIComponent(board)}`;
  const doorPath = () => `${scope()}/tasks/${taskId}/review-items/${itemId}/secrets`;

  /**
   * Every byte the server has written under its data directory, concatenated.
   *
   * Read as bytes rather than parsed, because the `.ydoc` files are a CRDT
   * encoding and a value could survive in one as a fragment no JSON reader
   * would surface. `latin1` maps every byte to one character, so a UTF-8
   * placeholder is still findable and no byte is lost to replacement.
   */
  const everythingOnDisk = (): string => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else out.push(readFileSync(full).toString('latin1'));
      }
    };
    walk(dataDir);
    return out.join('\n');
  };

  /** The asks on the task, as the board and `list_tasks` both read them. */
  const taskJson = async (): Promise<string> => {
    const body = await jj<unknown>(await local(`${scope()}/tasks?format=json`));
    return JSON.stringify(body);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'secret-item-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      // The seam. A real Keychain is never touched by this suite, and what
      // the writer was handed is the only evidence that the value moved at
      // all — which is why it is injected rather than reached for.
      secretWriter: async (service, value): Promise<SecretWriteResult> => {
        written.push({ service, value });
        return { ok: true };
      },
    });
    base = `http://127.0.0.1:${handle.port}`;

    board = (
      await jj<{ workspace: { id: string } }>(
        await postLocal('/workspaces', { name: 'Harborlight relay' }),
      )
    ).workspace.id;

    const link = await jj<{ link: { linkId: string } }>(
      await postLocal('/api/share/workspace', { workspaceId: board }),
    );
    expect(
      (
        await req(`/s/${link.link.linkId}`, SHARE_HOST, {
          headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, REGULAR) },
        })
      ).status,
    ).toBe(302);

    taskId = (
      await jj<{ task: { id: string } }>(
        await postLocal(`${scope()}/tasks`, {
          title: 'Post the nightly index to the Saltmarsh relay',
          body: 'Agent can post to the relay so that the index stays fresh.',
          author: AGENT,
        }),
      )
    ).task.id;

    itemId = (
      await jj<{ item: { id: string } }>(
        await postLocal(`${scope()}/tasks/${taskId}/review-items`, {
          review: {
            shape: 'secret',
            headline: 'Paste the two relay values so the nightly post can run',
            detail:
              'The nightly pass signs in to the Saltmarsh relay and posts the index. ' +
              'It needs the relay account it posts as and the token that account signs with.',
            secrets: [
              { label: 'Relay account name', service: 'saltmarsh-relay-account' },
              { label: 'Relay signing value', service: 'saltmarsh-relay-signer' },
            ],
          },
          author: AGENT,
        }),
      )
    ).item.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses a Regular User server-side, and no value reaches the writer', async () => {
    // AC 3. The refusal is the API's, not the page's: this is a real request
    // on the share hostname carrying a real token, and it is turned away
    // before the body is even read.
    //
    // WHICH gate turns it away is asserted, not assumed. Every sibling verb on
    // a review item is named in the host guard's member allowlist; this one is
    // not, so the guard refuses the address itself and `out_of_share_scope` is
    // the verdict. The route's own `refuseOwnerOnlyWrite` sits behind that as
    // the layer that fails closed if the allowlist ever gains the prefix —
    // which is why this assertion reads the error and not just the status.
    const before = written.length;
    const res = await postAsVisitor(REGULAR, doorPath(), {
      author: { id: 'u-regular', name: 'Regular User', kind: 'human' },
      secrets: [
        { service: 'saltmarsh-relay-account', value: FIRST_VALUE },
        { service: 'saltmarsh-relay-signer', value: SECOND_VALUE },
      ],
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
    expect(written).toHaveLength(before);
    // …and the item is still open, so the asking agent has not been told to
    // proceed on a hand-over that never happened.
    expect(await taskJson()).not.toContain('Secrets saved');
  });

  it('tells the queue whether the door is reachable, not just who is reading', async () => {
    // The card has to decide whether to OFFER the form, and the role alone is
    // the wrong input. An independent review found the case: an INVITED owner
    // — a share member promoted to the owner seat — reads `role: 'owner'` and
    // would have been shown an active form, while the door stays
    // `trusted-local` and refuses them in admission. A control that can never
    // succeed.
    //
    // Promoted through the board's own members route, so the fixture is the
    // product's way of making an owner rather than a hand-written record.
    expect(
      (await postLocal(`${scope()}/members/${encodeURIComponent(REGULAR)}/role`, { role: 'owner' }))
        .status,
    ).toBe(200);

    const asInvitedOwner = await jj<{ you: { role: string; canAnswerSecrets: boolean } }>(
      await req(`${scope()}/review-items`, SHARE_HOST, {
        headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, REGULAR) },
      }),
    );
    // The role really did move — without this the case below would pass on a
    // reader who was never an owner, which is the vacuous form of it.
    expect(asInvitedOwner.you.role).toBe('owner');
    expect(asInvitedOwner.you.canAnswerSecrets).toBe(false);

    // …and the field agrees with what the door actually does to them, which
    // is the whole point of sending it rather than deriving it in the client.
    const before = written.length;
    const res = await postAsVisitor(REGULAR, doorPath(), {
      author: { id: 'u-regular', name: 'Regular User', kind: 'human' },
      secrets: [
        { service: 'saltmarsh-relay-account', value: FIRST_VALUE },
        { service: 'saltmarsh-relay-signer', value: SECOND_VALUE },
      ],
    });
    expect(res.status).toBe(403);
    expect(written).toHaveLength(before);

    // The operator, on the same board, is told the opposite — so the
    // assertion above is a difference and not a field that reads false for
    // everybody.
    const asOperator = await jj<{ you: { role: string; canAnswerSecrets: boolean } }>(
      await local(`${scope()}/review-items`),
    );
    expect(asOperator.you).toEqual({ role: 'owner', canAnswerSecrets: true });

    // Put the seat back, so the ordering of these cases cannot matter.
    expect(
      (
        await postLocal(`${scope()}/members/${encodeURIComponent(REGULAR)}/role`, {
          role: 'member',
        })
      ).status,
    ).toBe(200);
  });

  it('refuses a body naming a service the item never asked for', async () => {
    const before = written.length;
    const res = await postLocal(doorPath(), {
      author: READER,
      secrets: [{ service: 'somewhere-else-entirely', value: FIRST_VALUE }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown-secret' });
    expect(written).toHaveLength(before);
  });

  it('refuses a partial hand-over rather than answering the item half-filled', async () => {
    const before = written.length;
    const res = await postLocal(doorPath(), {
      author: READER,
      secrets: [{ service: 'saltmarsh-relay-account', value: FIRST_VALUE }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'incomplete' });
    expect(written).toHaveLength(before);
    expect(await taskJson()).not.toContain('Secrets saved');
  });

  it('takes both values in one request and closes the item with the names only', async () => {
    // AC 1's server half: two fields, one submission, no second turn.
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    const err = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    let body: { saved: string[]; item: { answer?: { text?: string } } };
    try {
      // The instrument's own control, emitted inside the capture window. The
      // server turns out to log nothing at all on this path, so without a
      // line the capture is KNOWN to see, "no log line carried the value"
      // would be indistinguishable from "the spy was never wired". This
      // separates the two: the needle proves the capture works, and the
      // silence after it is then a real silence.
      console.log(LOG_CONTROL);
      body = await jj<{ saved: string[]; item: { answer?: { text?: string } } }>(
        await postLocal(doorPath(), {
          author: READER,
          secrets: [
            { service: 'saltmarsh-relay-account', value: FIRST_VALUE },
            { service: 'saltmarsh-relay-signer', value: SECOND_VALUE },
          ],
        }),
      );
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    logged = lines;

    expect(body.saved).toEqual(['saltmarsh-relay-account', 'saltmarsh-relay-signer']);
    expect(body.item.answer?.text).toBe(
      'Secrets saved: saltmarsh-relay-account, saltmarsh-relay-signer',
    );
    // The control for every absence below: both values DID travel, on this
    // request, to the writer and nowhere else.
    expect(written).toEqual([
      { service: 'saltmarsh-relay-account', value: FIRST_VALUE },
      { service: 'saltmarsh-relay-signer', value: SECOND_VALUE },
    ]);
    // …and the response the browser gets back carries neither.
    expect(JSON.stringify(body)).not.toContain(FIRST_VALUE);
    expect(JSON.stringify(body)).not.toContain(SECOND_VALUE);
  });

  it('leaves no value in anything the server stored or logged', async () => {
    // AC 2, one surface per assertion.
    // Wait for the OBSERVABLE, not a duration: the answer reaches the task's
    // `.ydoc` on the store's own debounce, and a sweep run before that flush
    // would report every absence below while proving nothing. Waiting for the
    // answer text to appear IS the control — the sweep is shown finding a
    // string this request really wrote.
    const disk = await waitFor(
      () => {
        const seen = everythingOnDisk();
        return seen.includes('Secrets saved: saltmarsh-relay-account') ? seen : false;
      },
      { describe: 'the answer to reach the data directory' },
    );
    // And the service names are on disk too, which is intended: they are the
    // only part of this hand-over anything is allowed to record.
    expect(disk).toContain('saltmarsh-relay-account');

    expect(disk).not.toContain(FIRST_VALUE); // the .ydoc, the events log, every file
    expect(disk).not.toContain(SECOND_VALUE);

    const asRead = await taskJson(); // the task, its answer, what list_tasks reads
    expect(asRead).toContain('Secrets saved: saltmarsh-relay-account, saltmarsh-relay-signer');
    expect(asRead).not.toContain(FIRST_VALUE);
    expect(asRead).not.toContain(SECOND_VALUE);

    // The activity feed, as the board reads its rows back.
    const feed = await jj<unknown>(await local(`${scope()}/events`));
    expect(JSON.stringify(feed)).not.toContain(FIRST_VALUE);
    expect(JSON.stringify(feed)).not.toContain(SECOND_VALUE);

    // Every line written to the console while the request was in flight. The
    // capture is shown working by its own control line; the server itself
    // logged nothing else on this path, and nothing it logged is a value.
    expect(logged).toContain(LOG_CONTROL);
    expect(logged.join('\n')).not.toContain(FIRST_VALUE);
    expect(logged.join('\n')).not.toContain(SECOND_VALUE);

    // And the task's threads, which is what an agent calling get_thread reads.
    const threads = await jj<unknown>(
      await local(`${scope()}/docs/${encodeURIComponent(`task:${taskId}`)}/threads`),
    );
    expect(JSON.stringify(threads)).not.toContain(FIRST_VALUE);
    expect(JSON.stringify(threads)).not.toContain(SECOND_VALUE);
  });
});
