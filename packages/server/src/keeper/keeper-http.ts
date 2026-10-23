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
 * - **The agent API** (`POST /v1/fly`, `/v1/cloudflare/*`, `GET
 *   /v1/requests/<id>`) must also carry `x-cw-keeper: 1`. A web page cannot
 *   add that header without a CORS preflight, which the keeper never grants.
 *   Any local process may call it: a routine call is safe for anyone to make,
 *   and a held one does nothing until Bryan's passkey answers.
 * - **The page's own posts** (challenge, approve, deny, enroll) must carry
 *   the page's `Origin`. An agent can forge that header, and it buys nothing:
 *   approving takes a passkey assertion, and enrolling takes a link only the
 *   keeper's user can mint.
 */
import { randomBytes } from 'node:crypto';
import { type Page, approvePage, enrollPage, indexPage } from './keeper-page.ts';
import type { HeldRequest, KeeperCall, KeeperRequests, Submitted } from './keeper-requests.ts';
import { type KeeperStore, hashToken } from './keeper-store.ts';
import { b64url, verifyRegistration } from './webauthn.ts';

export const API_HEADER = 'x-cw-keeper';
/** The header a held answer carries, so a client tells it from a result. */
export const HELD_HEADER = 'x-cw-keeper-held';
const MAX_BODY = 1024 * 1024;
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface KeeperHttpDeps {
  requests: KeeperRequests;
  store: KeeperStore;
  port: number;
  now?: () => number;
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
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

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

  return async function handle(req: Request, peer: string | null): Promise<Response> {
    const url = new URL(req.url);
    if (!peer || !LOOPBACK_PEERS.has(peer)) return json(403, { error: 'loopback only' });
    if (!hosts.has(req.headers.get('host') ?? '')) return json(403, { error: 'wrong host' });
    if (req.headers.has('cf-ray')) return json(403, { error: 'not through a tunnel' });
    const path = url.pathname;
    const method = req.method;
    const isApi = req.headers.get(API_HEADER) === '1';
    const fromPage = req.headers.get('origin') === origin;

    try {
      // ── Pages ────────────────────────────────────────────────────────────
      if (method === 'GET' && path === '/') return html(indexPage(requests.pending()));
      if (method === 'GET' && path === '/enroll') return html(enrollPage());
      const approveMatch = /^\/approve\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (method === 'GET' && approveMatch) {
        const r = requests.get(approveMatch[1] as string);
        return r ? html(approvePage(r)) : json(404, { error: 'no such request' });
      }

      // ── The agent API ───────────────────────────────────────────────────
      if (
        path === '/v1/fly' ||
        path.startsWith('/v1/cloudflare/') ||
        (path.startsWith('/v1/requests/') && method === 'GET')
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

      // ── The page's posts ────────────────────────────────────────────────
      const act = /^\/v1\/requests\/([A-Za-z0-9_-]{1,64})\/(challenge|approve|deny)$/.exec(path);
      if (method === 'POST' && (act || path.startsWith('/v1/enroll'))) {
        if (!fromPage) return json(403, { error: 'only the approval page may post here' });
      }
      if (method === 'POST' && act) {
        const [, id = '', verb] = act;
        if (verb === 'challenge') {
          const challenge = requests.challenge(id);
          if (!challenge) return json(409, { error: 'this request is not waiting' });
          return json(200, {
            challenge,
            rpId: 'localhost',
            allow: store.passkeys().map((p) => p.id),
          });
        }
        if (verb === 'deny') {
          const r = requests.deny(id);
          return r ? json(200, view(r)) : json(404, { error: 'no such request' });
        }
        const body = await readJson(req);
        try {
          const r = await requests.approve(id, {
            credentialId: str(body.credentialId),
            clientDataJSON: str(body.clientDataJSON),
            authenticatorData: str(body.authenticatorData),
            signature: str(body.signature),
          });
          return json(200, { ...view(r), ...(r.result ?? {}) });
        } catch (err) {
          return json(403, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (method === 'POST' && (path === '/v1/enroll/options' || path === '/v1/enroll')) {
        const body = await readJson(req);
        const record = store.enroll();
        if (
          !record ||
          record.expiresAt <= now() ||
          hashToken(str(body.token)) !== record.tokenHash
        ) {
          return json(403, { error: 'this enrollment link is not open' });
        }
        if (path === '/v1/enroll/options') {
          const challenge = b64url(new Uint8Array(randomBytes(32)));
          store.saveEnroll({ ...record, challenge });
          return json(200, {
            challenge,
            rpId: 'localhost',
            userId: b64url(new Uint8Array(randomBytes(16))),
          });
        }
        if (!record.challenge) return json(409, { error: 'ask for options first' });
        // The link is spent by this attempt, pass or fail.
        store.saveEnroll(null);
        const passkey = verifyRegistration(
          {
            clientDataJSON: str(body.clientDataJSON),
            attestationObject: str(body.attestationObject),
          },
          { challenge: record.challenge, origin, rpId: 'localhost' },
        );
        const list = store.passkeys().filter((p) => p.id !== passkey.id);
        store.savePasskeys([...list, passkey]);
        return json(200, { registered: passkey.id });
      }
      return json(404, { error: 'not found' });
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
