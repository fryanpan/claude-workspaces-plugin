/**
 * The GitHub relay: GitHub is read once, on the Mac, and each remote board
 * hears the events it subscribed to.
 *
 * One broker session per board. Each pass, for each board:
 *
 *  1. Read the board's subscriptions (`GET /workspaces/:ws/github/subscriptions`
 *     with its push key), at start and then every `subscriptionsEveryMs`.
 *  2. Make the broker session match them. The broker keeps sessions in
 *     memory and answers a `/poll` for a session it does not know with an
 *     empty list, so a session it forgot — after a restart, or after 30s
 *     without a poll — looks exactly like a quiet one. So the relay reads the
 *     broker's `/state` once per pass and registers again when its session is
 *     not in it, then watches or unwatches the difference.
 *  3. Poll the session, keep each line whose repo and kind the board wants,
 *     and push it (`POST /workspaces/:ws/github/events`). The board checks the
 *     same list again, so a stale copy here cannot widen what an agent hears.
 *
 * A push that fails on the network or with a 5xx stays queued, with the same
 * event id, and is sent again next pass; the board delivers an id once. A
 * push the board refuses (4xx) is dropped and logged. Nothing logged carries
 * a key or an event's text.
 */
import { randomBytes } from 'node:crypto';
import type { GithubSubscription } from '../github-hub.ts';
import { configuredHostFetch } from '../outbound-fetch.ts';
import { readBrokerLine } from './broker-line.ts';
import type { GithubRelayBoard, GithubRelayConfig } from './relay-config.ts';

export type GithubRelayFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GithubRelayDeps {
  config: GithubRelayConfig;
  fetch?: GithubRelayFetch;
  log?: (line: string) => void;
  now?: () => number;
  newId?: () => string;
  subscriptionsEveryMs?: number;
}

interface PendingPush {
  id: string;
  repo: string;
  kind: string;
  text: string;
}

interface BoardState {
  board: GithubRelayBoard;
  subscriptions: GithubSubscription[] | null;
  subscriptionsAt: number;
  session: string | null;
  pending: PendingPush[];
}

const REQUEST_TIMEOUT_MS = 10_000;
const SUBSCRIPTIONS_EVERY_MS = 60_000;
/** Pushes held for a board that is not answering, oldest dropped first. */
const MAX_PENDING = 200;

export interface GithubRelay {
  pollOnce(): Promise<void>;
  /** The broker session each board holds, by board name. For tests and logs. */
  sessions(): Record<string, string | null>;
}

export function createGithubRelay(deps: GithubRelayDeps): GithubRelay {
  // Only the broker and the configured boards, and no redirect followed: a
  // board answering with one cannot bounce a push key to another host.
  const doFetch: GithubRelayFetch =
    deps.fetch ??
    configuredHostFetch([deps.config.broker, ...deps.config.boards.map((b) => b.baseUrl)]);
  const log = deps.log ?? ((line: string) => console.error(`[github-relay] ${line}`));
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomBytes(12).toString('base64url'));
  const every = deps.subscriptionsEveryMs ?? SUBSCRIPTIONS_EVERY_MS;
  const broker = deps.config.broker;
  const boards: BoardState[] = deps.config.boards.map((board) => ({
    board,
    subscriptions: null,
    subscriptionsAt: 0,
    session: null,
    pending: [],
  }));

  /** The last line said under each key: a fault that persists is logged
   *  once, not once a pass. */
  const said = new Map<string, string>();
  const say = (key: string, line: string | null) => {
    if (line === null) said.delete(key);
    else if (said.get(key) !== line) {
      said.set(key, line);
      log(line);
    }
  };

  const call = (url: string, init: RequestInit = {}) =>
    doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  async function brokerPost<T>(path: string, body: unknown): Promise<T> {
    const res = await call(`${broker}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`broker ${path} answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** Each live session's repos, or null when the broker is not answering. */
  async function brokerSessions(): Promise<Map<string, Set<string>> | null> {
    try {
      const res = await call(`${broker}/state`);
      if (!res.ok) return null;
      const state = (await res.json()) as { sessions?: Array<{ id?: unknown; repos?: unknown }> };
      const out = new Map<string, Set<string>>();
      for (const s of state.sessions ?? []) {
        if (typeof s.id !== 'string') continue;
        out.set(
          s.id,
          new Set(Array.isArray(s.repos) ? s.repos.filter((r) => typeof r === 'string') : []),
        );
      }
      return out;
    } catch {
      return null;
    }
  }

  function boardHeaders(board: GithubRelayBoard): Record<string, string> {
    return {
      authorization: `Bearer ${board.pushKey}`,
      'content-type': 'application/json',
      ...(board.serviceToken
        ? {
            'cf-access-client-id': board.serviceToken.clientId,
            'cf-access-client-secret': board.serviceToken.clientSecret,
          }
        : {}),
    };
  }

  async function refreshSubscriptions(s: BoardState): Promise<void> {
    if (s.subscriptions !== null && now() - s.subscriptionsAt < every) return;
    const { board } = s;
    try {
      const res = await call(
        `${board.baseUrl}/workspaces/${encodeURIComponent(board.workspaceId)}/github/subscriptions`,
        { headers: boardHeaders(board) },
      );
      if (!res.ok) {
        say(
          `${board.name}/subs`,
          `${board.name}: subscriptions answered ${res.status}; keeping the last list`,
        );
        return;
      }
      const body = (await res.json()) as { subscriptions?: GithubSubscription[] };
      s.subscriptions = Array.isArray(body.subscriptions) ? body.subscriptions : [];
      s.subscriptionsAt = now();
      say(`${board.name}/subs`, null);
    } catch {
      say(`${board.name}/subs`, `${board.name}: subscriptions unreachable; keeping the last list`);
    }
  }

  async function matchSession(s: BoardState, live: Map<string, Set<string>>): Promise<void> {
    const wanted = new Set((s.subscriptions ?? []).map((sub) => sub.repo));
    const held = s.session ? live.get(s.session) : undefined;
    if (!held) {
      if (wanted.size === 0) {
        s.session = null;
        return;
      }
      const forgot = s.session !== null;
      const { id } = await brokerPost<{ id: string }>('/register', { repos: [...wanted] });
      s.session = id;
      log(
        `${s.board.name}: ${forgot ? 're-registered (the broker forgot the session)' : 'registered'}, watching ${wanted.size} repo(s)`,
      );
      return;
    }
    for (const repo of wanted) {
      if (!held.has(repo)) await brokerPost('/watch', { id: s.session, repo });
    }
    for (const repo of held) {
      if (!wanted.has(repo)) await brokerPost('/unwatch', { id: s.session, repo });
    }
  }

  function wants(s: BoardState, repo: string, kind: string): boolean {
    const r = repo.toLowerCase();
    return (s.subscriptions ?? []).some(
      (sub) => sub.repo.toLowerCase() === r && (sub.kinds as string[]).includes(kind),
    );
  }

  async function collect(s: BoardState): Promise<void> {
    if (!s.session) return;
    const { events } = await brokerPost<{ events?: unknown[] }>('/poll', { id: s.session });
    for (const line of events ?? []) {
      const e = readBrokerLine(line);
      if (!e || !wants(s, e.repo, e.kind)) continue;
      s.pending.push({ id: newId(), ...e });
    }
    if (s.pending.length > MAX_PENDING) {
      const dropped = s.pending.length - MAX_PENDING;
      s.pending.splice(0, dropped);
      log(`${s.board.name}: dropped ${dropped} undelivered event(s), the board is not answering`);
    }
  }

  async function flush(s: BoardState): Promise<void> {
    const { board } = s;
    while (s.pending.length > 0) {
      const push = s.pending[0] as PendingPush;
      let status: number;
      try {
        const res = await call(
          `${board.baseUrl}/workspaces/${encodeURIComponent(board.workspaceId)}/github/events`,
          { method: 'POST', headers: boardHeaders(board), body: JSON.stringify(push) },
        );
        status = res.status;
      } catch {
        say(
          `${board.name}/push`,
          `${board.name}: push unreachable; holding events for the next pass`,
        );
        return;
      }
      if (status >= 500) {
        say(
          `${board.name}/push`,
          `${board.name}: push answered ${status}; holding events for the next pass`,
        );
        return;
      }
      say(`${board.name}/push`, null);
      s.pending.shift();
      if (status !== 200)
        log(`${board.name}: push refused with ${status}; dropped event ${push.id}`);
    }
  }

  return {
    async pollOnce() {
      const live = await brokerSessions();
      say('broker', live === null ? 'broker not answering; holding sessions until it does' : null);
      for (const s of boards) {
        await refreshSubscriptions(s);
        if (live !== null) {
          try {
            await matchSession(s, live);
            await collect(s);
            say(`${s.board.name}/broker`, null);
          } catch (err) {
            say(
              `${s.board.name}/broker`,
              `${s.board.name}: broker call failed (${err instanceof Error ? err.message : 'error'})`,
            );
          }
        }
        await flush(s);
      }
    },
    sessions() {
      return Object.fromEntries(boards.map((s) => [s.board.name, s.session]));
    },
  };
}
