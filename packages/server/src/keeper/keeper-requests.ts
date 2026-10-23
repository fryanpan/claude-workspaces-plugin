/**
 * The keeper's requests: what runs now, what waits for a passkey, and what
 * one approval opens afterwards.
 *
 * A held request lives in memory only, with the stdin it will be run with
 * (a secret, for `fly secrets import`). A restart drops every held request,
 * and the requester asks again; nothing a requester sent is ever written to
 * disk. Each request has a random id, which the approval page names, and a
 * separate random poll token, which only the requester holds: the result of
 * a held command may carry what that command printed, so reading it takes
 * the token and not just the id.
 *
 * **An approval runs exactly the request Bryan read.** Its challenge is
 * issued for that one request and cleared on the first attempt, pass or
 * fail, so an assertion can approve nothing else and cannot be replayed.
 *
 * **One tap per project.** A `project.create` that succeeds adds the app to
 * the keeper's list (so routine starts and stops work on it from then on) and
 * opens a 30-minute grant on it, so the rest of that project's setup
 * (volumes, secrets, the image, a shell) runs without a second tap. An
 * `access.open` that succeeds opens a 10-minute grant on the new Access
 * application, so its policy can be written. Every other held request is
 * one tap each.
 */
import { randomBytes } from 'node:crypto';
import {
  ACCESS_GRANT_MS,
  type Grant,
  type HoldKind,
  SETUP_GRANT_MS,
  type Verdict,
  classifyCloudflare,
  classifyFly,
  grantCovers,
} from './keeper-policy.ts';
import type { KeeperStore } from './keeper-store.ts';
import {
  type AssertionInput,
  type CeremonyExpectation,
  b64url,
  verifyAssertion,
} from './webauthn.ts';

export interface FlyResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CloudflareResult {
  status: number;
  body: string;
}

export interface FlyCall {
  type: 'fly';
  args: string[];
  input?: string;
}

export interface CloudflareCall {
  type: 'cloudflare';
  method: string;
  /** Under `/client/v4`, with any query string. */
  path: string;
  body?: string;
}

export type KeeperCall = FlyCall | CloudflareCall;
export type KeeperResult = FlyResult | CloudflareResult;

export interface Executors {
  fly(args: string[], input: string | undefined): Promise<FlyResult>;
  cloudflare(method: string, path: string, body: string | undefined): Promise<CloudflareResult>;
}

export type RequestStatus = 'pending' | 'running' | 'done' | 'denied' | 'expired';

export interface HeldRequest {
  id: string;
  pollToken: string;
  call: KeeperCall;
  hold: HoldKind;
  app: string | null;
  summary: string;
  requester: string;
  createdAt: number;
  status: RequestStatus;
  challenge?: string;
  result?: KeeperResult;
  /** Why the approval or the command failed, for the page and the requester. */
  error?: string;
}

export type Submitted =
  | { outcome: 'ran'; result: KeeperResult }
  | { outcome: 'held'; request: HeldRequest }
  | { outcome: 'refused'; reason: string };

/** A pending request that nobody approves is dropped after an hour. */
export const PENDING_MS = 60 * 60_000;
/** A finished request's result stays readable for this long. */
export const RESULT_MS = 15 * 60_000;
const MAX_HELD = 100;

const token = (): string => b64url(new Uint8Array(randomBytes(24)));

export interface KeeperRequests {
  submit(call: KeeperCall, requester: string): Promise<Submitted>;
  get(id: string): HeldRequest | undefined;
  pending(): HeldRequest[];
  /** A fresh challenge for the approval page, or null when not pending. */
  challenge(id: string): string | null;
  approve(id: string, assertion: AssertionInput): Promise<HeldRequest>;
  deny(id: string): HeldRequest | undefined;
  grants(): Grant[];
}

export function createKeeperRequests(deps: {
  store: KeeperStore;
  exec: Executors;
  ceremony: Omit<CeremonyExpectation, 'challenge'>;
  now?: () => number;
  log?: (line: string) => void;
}): KeeperRequests {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const held = new Map<string, HeldRequest>();
  let grants: Grant[] = [];

  const sweep = () => {
    const t = now();
    grants = grants.filter((g) => g.expiresAt > t);
    for (const [id, r] of held) {
      if (r.status === 'pending' && t - r.createdAt > PENDING_MS) {
        r.status = 'expired';
        r.call = stripInput(r.call);
      }
      if (
        r.status !== 'pending' &&
        r.status !== 'running' &&
        t - r.createdAt > PENDING_MS + RESULT_MS
      ) {
        held.delete(id);
      }
    }
  };

  const classify = (call: KeeperCall): Verdict =>
    call.type === 'fly'
      ? classifyFly(call.args, deps.store.apps())
      : classifyCloudflare(call.method, call.path);

  const run = async (call: KeeperCall): Promise<KeeperResult> =>
    call.type === 'fly'
      ? deps.exec.fly(call.args, call.input)
      : deps.exec.cloudflare(call.method, call.path, call.body);

  /** After an approved request ran: record the app, open the grant. */
  const afterApproved = (r: HeldRequest, result: KeeperResult) => {
    const ok =
      r.call.type === 'fly' ? result.status === 0 : result.status >= 200 && result.status < 300;
    if (!ok) return;
    if (r.hold === 'project.create' && r.app) {
      deps.store.addApp(r.app);
      grants.push({ scope: 'fly', target: r.app, expiresAt: now() + SETUP_GRANT_MS });
      log(`project ${r.app} created; setup grant open for 30 minutes`);
    }
    if (r.hold === 'access.open' && r.call.type === 'cloudflare') {
      const id = accessAppId((result as CloudflareResult).body);
      if (id) {
        const target = `${r.call.path.split('?', 1)[0]?.replace(/\/$/, '')}/${id}`;
        grants.push({ scope: 'cloudflare', target, expiresAt: now() + ACCESS_GRANT_MS });
        log(`access application ${id} created; policy grant open for 10 minutes`);
      }
    }
  };

  return {
    async submit(call, requester) {
      sweep();
      const verdict = classify(call);
      if (verdict.kind === 'refused') {
        log(`refused ${requester}: ${verdict.reason}`);
        return { outcome: 'refused', reason: verdict.reason };
      }
      const cfPath = call.type === 'cloudflare' ? call.path : null;
      if (verdict.kind === 'routine' || grantCovers(grants, call.type, verdict, cfPath, now())) {
        log(`ran ${requester}: ${verdict.summary}`);
        return { outcome: 'ran', result: await run(call) };
      }
      const open = [...held.values()].filter((r) => r.status === 'pending').length;
      if (open >= MAX_HELD) return { outcome: 'refused', reason: 'too many requests are waiting' };
      const request: HeldRequest = {
        id: token(),
        pollToken: token(),
        call,
        hold: verdict.hold,
        app: verdict.app,
        summary: verdict.summary,
        requester: requester.slice(0, 120),
        createdAt: now(),
        status: 'pending',
      };
      held.set(request.id, request);
      log(`held ${request.id} for ${request.requester}: ${verdict.hold} ${verdict.summary}`);
      return { outcome: 'held', request };
    },

    get(id) {
      sweep();
      return held.get(id);
    },

    pending() {
      sweep();
      return [...held.values()].filter((r) => r.status === 'pending');
    },

    challenge(id) {
      sweep();
      const r = held.get(id);
      if (!r || r.status !== 'pending') return null;
      r.challenge = token();
      return r.challenge;
    },

    async approve(id, assertion) {
      sweep();
      const r = held.get(id);
      if (!r) throw new Error('no such request');
      if (r.status !== 'pending') throw new Error(`request is ${r.status}`);
      const challenge = r.challenge;
      // Single use, whatever the outcome below.
      r.challenge = undefined;
      if (!challenge) throw new Error('ask for a challenge first');
      const passkeys = deps.store.passkeys();
      const { id: passkeyId, signCount } = verifyAssertion(assertion, passkeys, {
        ...deps.ceremony,
        challenge,
      });
      deps.store.savePasskeys(passkeys.map((p) => (p.id === passkeyId ? { ...p, signCount } : p)));
      r.status = 'running';
      log(`approved ${r.id} with passkey ${passkeyId.slice(0, 8)}: ${r.summary}`);
      try {
        const result = await run(r.call);
        r.result = result;
        afterApproved(r, result);
      } catch (err) {
        r.error = err instanceof Error ? err.message : String(err);
      }
      r.status = 'done';
      r.call = stripInput(r.call);
      return r;
    },

    deny(id) {
      const r = held.get(id);
      if (!r || r.status !== 'pending') return r;
      r.status = 'denied';
      r.challenge = undefined;
      r.call = stripInput(r.call);
      log(`denied ${r.id}: ${r.summary}`);
      return r;
    },

    grants: () => grants.slice(),
  };
}

/** A request's stdin is dropped as soon as it can no longer run. */
function stripInput(call: KeeperCall): KeeperCall {
  return call.type === 'fly' && call.input !== undefined ? { ...call, input: undefined } : call;
}

function accessAppId(body: string): string | null {
  try {
    const id = (JSON.parse(body) as { result?: { id?: unknown } }).result?.id;
    return typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The names a `fly secrets import` stdin sets, never their values. */
export function secretNames(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split('\n')
    .map((line) => line.split('=', 1)[0]?.trim() ?? '')
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}
