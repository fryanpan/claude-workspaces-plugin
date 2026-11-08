/**
 * Asking the keeper, from a process that holds no credential: the board
 * server's Cloudflare calls, and the deploy scripts' `fly` calls.
 *
 * A routine call answers at once. A held one answers 202 with a link to the
 * approval page; the client says where to tap (`onHeld`), then polls with
 * its own poll token until Bryan approves, denies, or the wait runs out. A
 * request nobody approved in time is withdrawn, so it cannot be approved
 * after the requester has gone. Once approved, the command has a limit of
 * its own (`runMs`), at least as long as the keeper lets `fly` run.
 * `CW_KEEPER_URL` (for example `http://localhost:8797`) is the setting that
 * turns this on; without it every caller keeps its old path. Every request
 * carries the caller token, read from the caller token file
 * (`keeper-callers.ts`); without it the keeper refuses the call.
 */
import { configuredHostFetch } from '../outbound-fetch.ts';
import { CALLER_HEADER, callerTokenPath, readCallerToken } from './keeper-callers.ts';
import { FLY_TIMEOUT_MS } from './keeper-exec.ts';
import { API_HEADER, HELD_HEADER } from './keeper-http.ts';
import type { CloudflareResult, FlyResult } from './keeper-requests.ts';

export const KEEPER_URL_ENV = 'CW_KEEPER_URL';

export interface HeldAnswer {
  id: string;
  pollToken: string;
  hold: string;
  summary: string;
  approveUrl: string;
  /** A grant covered the call: it is already running, and needs no tap. */
  started?: boolean;
}

export interface KeeperClientOptions {
  /** Told once per held call, with the page to open. */
  onHeld?: (held: HeldAnswer) => void;
  /**
   * Also told once per held call: puts the request on Bryan's Home
   * (`announceToBoard` in `keeper-announce.ts`). Must not throw or wait.
   */
  announce?: (held: HeldAnswer) => void;
  /** How long to wait for a tap. Default 10 minutes. */
  waitMs?: number;
  /** How long an approved command may run. Default: fly's own limit, and a minute. */
  runMs?: number;
  pollMs?: number;
  requester?: string;
  /** The caller token; read from the caller token file when not given. */
  callerToken?: string;
  /** Injected in tests; production is the configured-host guard. */
  fetchImpl?: typeof fetch;
}

/** The token to send, and why there is none when there is none. */
function callerOf(opts: KeeperClientOptions): { token: string | null; problem?: string } {
  if (opts.callerToken !== undefined) return { token: opts.callerToken };
  const read = readCallerToken(callerTokenPath());
  return 'token' in read ? { token: read.token } : { token: null, problem: read.problem };
}

/** The headers every agent-API request carries. */
function apiHeaders(token: string | null): Record<string, string> {
  return { [API_HEADER]: '1', ...(token ? { [CALLER_HEADER]: token } : {}) };
}

type Waited<T> = { ok: true; result: T } | { ok: false; error: string };

/** Give up on a held request: the keeper drops it, so no later tap runs it. */
export async function withdrawRequest(
  origin: string,
  held: Pick<HeldAnswer, 'id' | 'pollToken'>,
  doFetch: typeof fetch,
  callerToken: string | null = callerOf({}).token,
): Promise<boolean> {
  try {
    const res = await doFetch(`${origin}/v1/requests/${held.id}`, {
      method: 'DELETE',
      headers: { ...apiHeaders(callerToken), 'x-cw-keeper-poll': held.pollToken },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForApproval<T>(
  origin: string,
  held: HeldAnswer,
  opts: KeeperClientOptions,
  doFetch: typeof fetch,
  callerToken: string | null,
): Promise<Waited<T>> {
  // A grant covered it: it is running, and nobody needs to be told to tap.
  if (!held.started) {
    opts.onHeld?.(held);
    opts.announce?.(held);
  }
  const runLimit = () => Date.now() + (opts.runMs ?? FLY_TIMEOUT_MS + 60_000);
  let running = held.started === true;
  let deadline = running ? runLimit() : Date.now() + (opts.waitMs ?? 10 * 60_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
    const res = await doFetch(`${origin}/v1/requests/${held.id}`, {
      headers: { ...apiHeaders(callerToken), 'x-cw-keeper-poll': held.pollToken },
    });
    if (!res.ok) return { ok: false, error: `the keeper lost request ${held.id}` };
    const view = (await res.json()) as { status: string; result?: T; error?: string };
    if (view.status === 'done') {
      if (view.result) return { ok: true, result: view.result };
      return { ok: false, error: view.error ?? 'the approved command did not run' };
    }
    if (view.status === 'denied' || view.status === 'expired' || view.status === 'withdrawn') {
      return { ok: false, error: `${held.summary} was ${view.status}` };
    }
    // Approved: the tap wait no longer applies, the run's own limit does.
    if (view.status === 'running' && !running) {
      running = true;
      deadline = runLimit();
    }
  }
  if (running) {
    return { ok: false, error: `${held.summary} was approved and is still running past the wait` };
  }
  const withdrawn = await withdrawRequest(origin, held, doFetch, callerToken);
  return {
    ok: false,
    error: withdrawn
      ? 'no approval within the wait; the request was withdrawn, so ask again'
      : `no approval within the wait, and it could not be withdrawn; deny it at ${held.approveUrl}`,
  };
}

/**
 * A `fetch` for `CfApi` whose `apiBase` is `<keeper>/v1/cloudflare`. A held
 * call resolves to the approved call's own response; a denied or timed-out
 * one to a 403 that names the approval page, which `CfApi` throws as its
 * error.
 */
export function keeperFetch(origin: string, opts: KeeperClientOptions = {}): typeof fetch {
  const doFetch = opts.fetchImpl ?? configuredHostFetch([origin]);
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const caller = callerOf(opts);
    const headers = new Headers(init?.headers);
    headers.delete('authorization');
    for (const [k, v] of Object.entries(apiHeaders(caller.token))) headers.set(k, v);
    if (opts.requester) headers.set('x-cw-requester', opts.requester);
    const res = await doFetch(String(input instanceof Request ? input.url : input), {
      ...init,
      headers,
    });
    if (res.status === 401 && caller.problem) {
      const why = await res.text().catch(() => '');
      return new Response(JSON.stringify({ error: `${caller.problem} (${why.slice(0, 200)})` }), {
        status: 401,
      });
    }
    if (!res.headers.has(HELD_HEADER)) return res;
    const held = (await res.json()) as HeldAnswer;
    const waited = await waitForApproval<CloudflareResult>(
      origin,
      held,
      opts,
      doFetch,
      caller.token,
    );
    if (!waited.ok) {
      return new Response(JSON.stringify({ error: waited.error, approveUrl: held.approveUrl }), {
        status: 403,
      });
    }
    return new Response(waited.result.body, { status: waited.result.status });
  };
  return wrapped as typeof fetch;
}

/** One `fly` call through the keeper. */
export function keeperFly(
  origin: string,
  args: string[],
  input: string | undefined,
  opts: KeeperClientOptions = {},
): Promise<FlyResult> {
  return postAndWait(origin, '/v1/fly', { args, ...(input !== undefined ? { input } : {}) }, opts);
}

/**
 * One Cloudflare Terraform run through the keeper (`keeper-terraform.ts`):
 * a plan answers at once; an apply is planned, then waits for a tap. `input`
 * is the configs and the state bucket's credential, as JSON.
 */
export function keeperTerraform(
  origin: string,
  command: 'plan' | 'apply',
  env: 'prod' | 'staging',
  input: string,
  opts: KeeperClientOptions = {},
): Promise<FlyResult> {
  return postAndWait(origin, '/v1/terraform', { command, env, input }, opts);
}

/** POST one call, and wait out a hold; a refusal or a failed wait is a failed result. */
async function postAndWait(
  origin: string,
  path: string,
  body: Record<string, unknown>,
  opts: KeeperClientOptions,
): Promise<FlyResult> {
  const doFetch = opts.fetchImpl ?? configuredHostFetch([origin]);
  const caller = callerOf(opts);
  const res = await doFetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...apiHeaders(caller.token),
      ...(opts.requester ? { 'x-cw-requester': opts.requester } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let reason = text.slice(0, 200) || 'no reason given';
    try {
      reason = (JSON.parse(text) as { error?: string }).error ?? reason;
    } catch {
      // not JSON: the text itself is the reason
    }
    if (res.status === 401 && caller.problem) reason = `${caller.problem} (${reason})`;
    return {
      status: 1,
      stdout: '',
      stderr:
        res.status === 403
          ? `the keeper refused: ${reason}`
          : `the keeper answered ${res.status}: ${reason}`,
    };
  }
  if (!res.headers.has(HELD_HEADER)) return (await res.json()) as FlyResult;
  const held = (await res.json()) as HeldAnswer;
  const waited = await waitForApproval<FlyResult>(origin, held, opts, doFetch, caller.token);
  return waited.ok ? waited.result : { status: 1, stdout: '', stderr: waited.error };
}

/**
 * Ask the keeper to make `app`'s push deploy keys on `repos`
 * (`keeper-push-keys.ts`). Always a tap. The answer names each key's id and
 * public half; the private halves went to the app's secret and are not in it.
 */
export async function keeperPushKeys(
  origin: string,
  app: string,
  repos: readonly string[],
  opts: KeeperClientOptions = {},
): Promise<CloudflareResult> {
  const doFetch = opts.fetchImpl ?? configuredHostFetch([origin]);
  const caller = callerOf(opts);
  const res = await doFetch(`${origin}/v1/push-keys`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...apiHeaders(caller.token),
      ...(opts.requester ? { 'x-cw-requester': opts.requester } : {}),
    },
    body: JSON.stringify({ app, repos }),
  });
  if (!res.headers.has(HELD_HEADER)) {
    const text = await res.text().catch(() => '');
    const status = res.ok ? 502 : res.status;
    const reason = res.ok ? 'the keeper ran a push-key request without a tap' : text.slice(0, 300);
    return { status, body: JSON.stringify({ error: reason }) };
  }
  const held = (await res.json()) as HeldAnswer;
  const waited = await waitForApproval<CloudflareResult>(origin, held, opts, doFetch, caller.token);
  return waited.ok ? waited.result : { status: 403, body: JSON.stringify({ error: waited.error }) };
}

/**
 * Ask for one board's move grant on `app` (`keeper-grants.ts`). Always a tap.
 * The call returns once the owner approved or denied.
 */
export async function keeperMoveGrant(
  origin: string,
  app: string,
  board: string,
  opts: KeeperClientOptions = {},
): Promise<CloudflareResult> {
  const doFetch = opts.fetchImpl ?? configuredHostFetch([origin]);
  const caller = callerOf(opts);
  const res = await doFetch(`${origin}/v1/move-grant`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...apiHeaders(caller.token),
      ...(opts.requester ? { 'x-cw-requester': opts.requester } : {}),
    },
    body: JSON.stringify({ app, board }),
  });
  if (!res.headers.has(HELD_HEADER)) {
    const text = await res.text().catch(() => '');
    const status = res.ok ? 502 : res.status;
    const reason = res.ok ? 'the keeper opened a move grant without a tap' : text.slice(0, 300);
    return { status, body: JSON.stringify({ error: reason }) };
  }
  const held = (await res.json()) as HeldAnswer;
  const waited = await waitForApproval<CloudflareResult>(origin, held, opts, doFetch, caller.token);
  return waited.ok ? waited.result : { status: 403, body: JSON.stringify({ error: waited.error }) };
}
