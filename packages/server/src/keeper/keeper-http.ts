/**
 * The keeper's HTTP surface, on loopback only. Not a board-server route:
 * the keeper is its own process under its own macOS user, and nothing here
 * is mounted on the board server.
 *
 * Who may call what:
 *
 * - **Every request** must come from a loopback peer, name the keeper's own
 *   host (`localhost:<port>` or `127.0.0.1:<port>`, so a rebound DNS name
 *   cannot reach it from a browser), and carry no `cf-ray`.
 * - **The agent API** (`POST /v1/fly`, `/v1/cloudflare/*`, `GET` and
 *   `DELETE /v1/requests/<id>`) must also carry `x-cw-keeper: 1`. A web page cannot
 *   add that header without a CORS preflight, which the keeper never grants.
 *   Any local process may call it: a routine call is safe for anyone to make,
 *   and a held one does nothing until Bryan's passkey answers.
 * - **The page's own posts** (challenge, approve, deny, enroll) must carry
 *   the page's `Origin`. That stops another web page, not a local process,
 *   which can forge it. What stops a local process: approving and denying
 *   take a passkey assertion on a challenge issued to one served page; and
 *   an enrollment link is spent by the first page that asks for options, and
 *   opens nothing on a keeper that started after the link was made.
 *
 * The page origin is `http://localhost:<port>`, and `localhost` may resolve
 * to either loopback address, so the port is held on both: by launchd's own
 * listeners in production (`keeper-launchd.ts`), or by `keeper-serve.ts`,
 * which refuses to start if either is taken. A process that listens there
 * while no keeper runs can serve a lookalike page, but every challenge and
 * every live link belongs to a running keeper, so that page can obtain
 * nothing to sign.
 */
import { randomBytes } from 'node:crypto';
import { type Page, alarmPage, approvePage, enrollPage, indexPage } from './keeper-page.ts';
import type { HeldRequest, KeeperCall, KeeperRequests, Submitted } from './keeper-requests.ts';
import { type KeeperStore, hashToken } from './keeper-store.ts';
import { CLEAR_SITE_DATA, REMOVING_WORKER, workerEvidence } from './keeper-worker-guard.ts';
import { b64url, verifyRegistration } from './webauthn.ts';

export const API_HEADER = 'x-cw-keeper';
/** The header a held answer carries, so a client tells it from a result. */
export const HELD_HEADER = 'x-cw-keeper-held';
const MAX_BODY = 1024 * 1024;
/**
 * The peer `keeper-serve.ts` names for a connection on its unix socket, which
 * only launchd's loopback listeners relay to (`keeper-launchd.ts`). No TCP
 * peer address can take this value.
 */
export const RELAYED_PEER = 'launchd-relay';
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', RELAYED_PEER]);

export interface KeeperHttpDeps {
  requests: KeeperRequests;
  store: KeeperStore;
  port: number;
  now?: () => number;
  log?: (line: string) => void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

const html = (p: Page, status = 200): Response =>
  new Response(p.html, { status, headers: p.headers });

async function readBody(req: Request): Promise<string> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error('body is too large');
  return text;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  const parsed: unknown = text ? JSON.parse(text) : {};
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What a requester polls: the state, and the result once there is one. */
function view(r: HeldRequest): Record<string, unknown> {
  return {
    id: r.id,
    status: r.status,
    hold: r.hold,
    summary: r.summary,
    ...(r.result ? { result: r.result } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

export function createKeeperHttp(deps: KeeperHttpDeps) {
  const { requests, store, port } = deps;
  const now = deps.now ?? Date.now;
  const origin = `http://localhost:${port}`;
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const startedAt = now();

  const answer = (s: Submitted): Response => {
    if (s.outcome === 'refused') return json(403, { error: s.reason });
    if (s.outcome === 'ran') {
      // A Cloudflare call answers as Cloudflare did, so `CfApi` reads it unchanged.
      if ('body' in s.result) {
        return new Response(s.result.body, {
          status: s.result.status,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      }
      return json(200, s.result);
    }
    return json(
      202,
      {
        held: true,
        id: s.request.id,
        pollToken: s.request.pollToken,
        hold: s.request.hold,
        summary: s.request.summary,
        approveUrl: `${origin}/approve/${s.request.id}`,
      },
      { [HELD_HEADER]: '1' },
    );
  };

  const log = deps.log ?? (() => {});
  /** The alarm is raised once and stays until the owner clears it. */
  const raise = (reason: string) => {
    if (store.alarm()) return;
    store.saveAlarm({ at: now(), reason });
    log(`alarm: ${reason}; approvals and enrollment are stopped`);
  };
  const stopped = () => json(423, { error: 'the keeper saw a service worker on its origin' });

  // Every response tells the browser to drop any worker and cache it holds
  // here, and to keep no copy of this one.
  return async function handle(req: Request, peer: string | null): Promise<Response> {
    const res = await route(req, peer);
    res.headers.set('clear-site-data', CLEAR_SITE_DATA);
    res.headers.set('cache-control', 'no-store');
    return res;
  };

  async function route(req: Request, peer: string | null): Promise<Response> {
    const url = new URL(req.url);
    if (!peer || !LOOPBACK_PEERS.has(peer)) return json(403, { error: 'loopback only' });
    if (!hosts.has(req.headers.get('host') ?? '')) return json(403, { error: 'wrong host' });
    if (req.headers.has('cf-ray')) return json(403, { error: 'not through a tunnel' });
    const evidence = workerEvidence(req);
    if (evidence) raise(evidence);
    if (req.headers.has('service-worker')) {
      return new Response(REMOVING_WORKER, {
        headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' },
      });
    }
    const alarm = store.alarm();
    const path = url.pathname;
    const method = req.method;
    const isApi = req.headers.get(API_HEADER) === '1';
    const fromPage = req.headers.get('origin') === origin;

    try {
      // ── Pages ────────────────────────────────────────────────────────────
      const enrollMatch = /^\/enroll\/[A-Za-z0-9_-]{16,64}$/.test(path);
      const approveMatch = /^\/approve\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (method === 'GET' && alarm && (path === '/' || enrollMatch || approveMatch)) {
        return html(alarmPage(alarm.reason, alarm.at, port));
      }
      if (method === 'GET' && path === '/') return html(indexPage(requests.pending()));
      // The link's path is new each time, so no page cached under it can exist.
      if (method === 'GET' && enrollMatch) return html(enrollPage());
      if (method === 'GET' && approveMatch) {
        const id = approveMatch[1] as string;
        const r = requests.get(id);
        return r
          ? html(approvePage(r, requests.openPage(id)))
          : json(404, { error: 'no such request' });
      }

      // ── The agent API ───────────────────────────────────────────────────
      if (
        path === '/v1/fly' ||
        path.startsWith('/v1/cloudflare/') ||
        (path.startsWith('/v1/requests/') && (method === 'GET' || method === 'DELETE'))
      ) {
        if (!isApi) return json(403, { error: `the API needs ${API_HEADER}: 1` });
      }
      const requester = (req.headers.get('x-cw-requester') ?? '').slice(0, 120);
      if (method === 'POST' && path === '/v1/fly') {
        const body = await readJson(req);
        const input = body.input === undefined ? undefined : str(body.input);
        const call: KeeperCall = {
          type: 'fly',
          args: body.args as string[],
          ...(input !== undefined ? { input } : {}),
        };
        return answer(await requests.submit(call, requester));
      }
      if (path.startsWith('/v1/cloudflare/')) {
        const body = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
        const call: KeeperCall = {
          type: 'cloudflare',
          method,
          path: `${path.slice('/v1/cloudflare'.length)}${url.search}`,
          ...(body ? { body } : {}),
        };
        return answer(await requests.submit(call, requester));
      }
      const pollMatch = /^\/v1\/requests\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (method === 'GET' && pollMatch) {
        const r = requests.get(pollMatch[1] as string);
        if (!r || req.headers.get('x-cw-keeper-poll') !== r.pollToken) {
          return json(404, { error: 'no such request' });
        }
        return json(200, view(r));
      }
      // The requester stops waiting: only its poll token can withdraw it.
      if (method === 'DELETE' && pollMatch) {
        const r = requests.withdraw(
          pollMatch[1] as string,
          req.headers.get('x-cw-keeper-poll') ?? '',
        );
        if ('error' in r) {
          return r.error === 'not-waiting'
            ? json(409, { error: 'this request is not waiting' })
            : json(404, { error: 'no such request' });
        }
        return json(200, view(r));
      }

      // ── The page's posts ────────────────────────────────────────────────
      const act = /^\/v1\/requests\/([A-Za-z0-9_-]{1,64})\/(challenge|approve|deny)$/.exec(path);
      if (method === 'POST' && (act || path.startsWith('/v1/enroll'))) {
        if (!fromPage) return json(403, { error: 'only the approval page may post here' });
        if (alarm) return stopped();
      }
      if (method === 'POST' && act) {
        const [, id = '', verb] = act;
        const body = await readJson(req);
        const pageToken = str(body.page);
        if (verb === 'challenge') {
          const c = requests.challenge(id, pageToken);
          if ('error' in c) {
            return c.error === 'no-page'
              ? json(403, { error: 'load the approval page again' })
              : json(409, { error: 'this request is not waiting' });
          }
          return json(200, {
            challenge: c.challenge,
            rpId: 'localhost',
            allow: store.passkeys().map((p) => p.id),
          });
        }
        const assertion = {
          credentialId: str(body.credentialId),
          clientDataJSON: str(body.clientDataJSON),
          authenticatorData: str(body.authenticatorData),
          signature: str(body.signature),
        };
        try {
          if (verb === 'deny') return json(200, view(requests.deny(id, pageToken, assertion)));
          const r = await requests.approve(id, pageToken, assertion);
          return json(200, { ...view(r), ...(r.result ?? {}) });
        } catch (err) {
          return json(403, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (method === 'POST' && path === '/v1/enroll/options') {
        const body = await readJson(req);
        const record = store.enroll();
        if (
          !record ||
          record.expiresAt <= now() ||
          !record.tokenHash ||
          !(record.createdAt >= startedAt) ||
          hashToken(str(body.token)) !== record.tokenHash
        ) {
          return json(403, { error: 'this enrollment link is not open' });
        }
        const challenge = b64url(new Uint8Array(randomBytes(32)));
        const session = b64url(new Uint8Array(randomBytes(24)));
        // The link is spent here: a second caller holding it gets nothing,
        // and only this caller's session can finish.
        store.saveEnroll({
          tokenHash: '',
          expiresAt: record.expiresAt,
          createdAt: record.createdAt,
          challenge,
          sessionHash: hashToken(session),
        });
        return json(200, {
          challenge,
          session,
          rpId: 'localhost',
          userId: b64url(new Uint8Array(randomBytes(16))),
        });
      }
      if (method === 'POST' && path === '/v1/enroll') {
        const body = await readJson(req);
        const record = store.enroll();
        if (
          !record?.challenge ||
          !record.sessionHash ||
          record.expiresAt <= now() ||
          hashToken(str(body.session)) !== record.sessionHash
        ) {
          return json(403, { error: 'this enrollment is not open' });
        }
        // Spent by this attempt, pass or fail.
        store.saveEnroll(null);
        const passkey = verifyRegistration(
          {
            clientDataJSON: str(body.clientDataJSON),
            attestationObject: str(body.attestationObject),
          },
          { challenge: record.challenge, origin, rpId: 'localhost' },
        );
        if (store.passkeys().some((p) => p.id === passkey.id)) {
          return json(409, { error: 'this passkey is already registered' });
        }
        store.savePasskeys([...store.passkeys(), passkey]);
        return json(200, { registered: passkey.id });
      }
      return json(404, { error: 'not found' });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
