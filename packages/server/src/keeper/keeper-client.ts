/**
 * Asking the keeper, from a process that holds no credential: the board
 * server's Cloudflare calls, and the deploy scripts' `fly` calls.
 *
 * A routine call answers at once. A held one answers 202 with a link to the
 * approval page; the client says where to tap (`onHeld`), then polls with
 * its own poll token until Bryan approves, denies, or the wait runs out.
 * `CW_KEEPER_URL` (for example `http://localhost:8797`) is the setting that
 * turns this on; without it every caller keeps its old path.
 */
import { configuredHostFetch } from '../outbound-fetch.ts';
import { API_HEADER, HELD_HEADER } from './keeper-http.ts';
import type { CloudflareResult, FlyResult } from './keeper-requests.ts';

export const KEEPER_URL_ENV = 'CW_KEEPER_URL';

export interface HeldAnswer {
  id: string;
  pollToken: string;
  hold: string;
  summary: string;
  approveUrl: string;
}

export interface KeeperClientOptions {
  /** Told once per held call, with the page to open. */
  onHeld?: (held: HeldAnswer) => void;
  /** How long to wait for a tap. Default 10 minutes. */
  waitMs?: number;
  pollMs?: number;
  requester?: string;
  /** Injected in tests; production is the configured-host guard. */
  fetchImpl?: typeof fetch;
}

type Waited<T> = { ok: true; result: T } | { ok: false; error: string };

async function waitForApproval<T>(
  origin: string,
  held: HeldAnswer,
  opts: KeeperClientOptions,
  doFetch: typeof fetch,
): Promise<Waited<T>> {
  opts.onHeld?.(held);
  const deadline = Date.now() + (opts.waitMs ?? 10 * 60_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
    const res = await doFetch(`${origin}/v1/requests/${held.id}`, {
      headers: { [API_HEADER]: '1', 'x-cw-keeper-poll': held.pollToken },
    });
    if (!res.ok) return { ok: false, error: `the keeper lost request ${held.id}` };
    const view = (await res.json()) as { status: string; result?: T; error?: string };
    if (view.status === 'done') {
      if (view.result) return { ok: true, result: view.result };
      return { ok: false, error: view.error ?? 'the approved command did not run' };
    }
    if (view.status === 'denied' || view.status === 'expired') {
      return { ok: false, error: `${held.summary} was ${view.status}` };
    }
  }
  return {
    ok: false,
    error: `no approval within the wait; it is still open at ${held.approveUrl}`,
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
    const headers = new Headers(init?.headers);
    headers.set(API_HEADER, '1');
    headers.delete('authorization');
    if (opts.requester) headers.set('x-cw-requester', opts.requester);
    const res = await doFetch(String(input instanceof Request ? input.url : input), {
      ...init,
      headers,
    });
    if (!res.headers.has(HELD_HEADER)) return res;
    const held = (await res.json()) as HeldAnswer;
    const waited = await waitForApproval<CloudflareResult>(origin, held, opts, doFetch);
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
export async function keeperFly(
  origin: string,
  args: string[],
  input: string | undefined,
  opts: KeeperClientOptions = {},
): Promise<FlyResult> {
  const doFetch = opts.fetchImpl ?? configuredHostFetch([origin]);
  const res = await doFetch(`${origin}/v1/fly`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [API_HEADER]: '1',
      ...(opts.requester ? { 'x-cw-requester': opts.requester } : {}),
    },
    body: JSON.stringify({ args, ...(input !== undefined ? { input } : {}) }),
  });
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      status: 1,
      stdout: '',
      stderr: `the keeper refused: ${body.error ?? 'no reason given'}`,
    };
  }
  if (!res.headers.has(HELD_HEADER)) return (await res.json()) as FlyResult;
  const held = (await res.json()) as HeldAnswer;
  const waited = await waitForApproval<FlyResult>(origin, held, opts, doFetch);
  return waited.ok ? waited.result : { status: 1, stdout: '', stderr: waited.error };
}
