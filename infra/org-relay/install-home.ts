/**
 * The half of `relay:install` that is Home's, not the relay's: the board
 * tokens the Mac's server pulls each remote board's home feed with and acks
 * its stall escalations with (`home-remotes.ts`, `CW_HOME_REMOTES_FILE`).
 *
 * On a project server with no Access in front, the ack
 * (`POST /workspaces/<board>/home-feed/escalation-ack`) is admitted only with
 * an `at2` for that board minted for the server's Team Lead
 * (`escalationAckCallerAllowed`, `routes/home-feed.ts`), and the feed pull
 * uses the same token. So for every seat board on such a server, the file's
 * `boardTokens` entry must be a live `at2` minted for Team Lead's agent id.
 * One is kept while its record is live, judged by the value the Mac's server
 * renewed it to (`home-remote-tokens.ts`, the relay's rule); otherwise one is
 * minted, and the record it replaces is revoked once the check passes.
 *
 * The Mac's server reads the file only at start, so a change to it means a
 * restart of that server.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { bearerExpiresAt } from '../../packages/server/src/org-relay/relay-bearers.ts';
import { type BoardCall, type TokenRecord, mintToken } from './install-api.ts';
import { type ResolvedSeat, type ServerPlan, tokenIdOf } from './install-plan.ts';

/** The label a home-feed token is minted with: only these are ever revoked. */
export const HOME_FEED_LABEL = 'home feed';

const UNMINTED = 'at2.unminted.home.board.0.x';

export interface HomeFeedPlan {
  /** The file's new text, or null when nothing in it changes. */
  text: string | null;
  revokes: Array<{ call: BoardCall; id: string; where: string }>;
  /** Board → the token the check reads its feed with, and the server's address. */
  checks: Array<{ board: string; baseUrl: string; token: string }>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function readJson(path: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function planHomeFeedTokens(args: {
  servers: readonly ServerPlan[];
  seats: readonly ResolvedSeat[];
  calls: ReadonlyMap<string, BoardCall>;
  records: ReadonlyMap<string, TokenRecord[]>;
  /** The Mac seat's agent: Team Lead. */
  teamLead: string;
  /** The file `CW_HOME_REMOTES_FILE` names, or undefined when not given. */
  path: string | undefined;
  /** `<dataDir>/home-remote-tokens.json`, the Mac server's renewed values. */
  renewedPath: string;
  remint: boolean;
  dryRun: boolean;
  now: number;
  say: (line: string) => void;
}): Promise<HomeFeedPlan> {
  const plan: HomeFeedPlan = { text: null, revokes: [], checks: [] };
  const open = args.servers.filter((s) => s.app && !s.accessInFront);
  if (open.length === 0) return plan;
  const would = args.dryRun ? 'would ' : '';
  if (!args.path) {
    throw new Error(
      `${open.map((s) => s.id).join(', ')} has no Access in front, so Home acks its escalations with a token for ${args.teamLead}: pass --home-remotes <the file CW_HOME_REMOTES_FILE names>`,
    );
  }
  if (!existsSync(args.path)) throw new Error(`${args.path} does not exist`);
  if ((statSync(args.path).mode & 0o077) !== 0) {
    throw new Error(`${args.path} is readable by others; chmod 600 it first`);
  }
  const before = readFileSync(args.path, 'utf8');
  const file = JSON.parse(before) as Record<string, unknown>;
  const origins = (file.boardOrigins ?? {}) as Record<string, unknown>;
  const listed = new Set(Object.values(origins).flatMap((v) => (Array.isArray(v) ? v : [])));
  const tokens = { ...((file.boardTokens ?? {}) as Record<string, string>) };
  const renewed = readJson(args.renewedPath) as Record<string, { value?: string; from?: string }>;
  for (const server of open) {
    const call = args.calls.get(server.id) as BoardCall;
    const records = args.records.get(server.id) ?? [];
    for (const board of new Set(
      args.seats.filter((s) => s.server === server.id).map((s) => s.board),
    )) {
      if (!listed.has(board)) {
        throw new Error(
          `${args.path} boardOrigins does not list ${board}; add it to the routing table first`,
        );
      }
      const where = `${server.id} board ${board}`;
      const raw = tokens[board];
      const saved = raw ? renewed[board] : undefined;
      const held = saved?.value && saved.from === sha(raw as string) ? saved.value : raw;
      const record = records.find((r) => r.id === (held ? tokenIdOf(held) : null));
      const live =
        record !== undefined &&
        record.revokedAt === undefined &&
        record.agentId === args.teamLead &&
        record.boardId === board &&
        (bearerExpiresAt(held as string) ?? 0) > args.now;
      const keep = live && !args.remint && raw !== undefined;
      for (const r of records) {
        const ours =
          r.agentId === args.teamLead && r.boardId === board && r.label === HOME_FEED_LABEL;
        if (ours && r.revokedAt === undefined && !(keep && r.id === record?.id)) {
          plan.revokes.push({ call, id: r.id, where });
        }
      }
      if (keep) {
        args.say(`keeps Home's token for ${args.teamLead} on ${where} (record ${record?.id})`);
        plan.checks.push({ board, baseUrl: server.baseUrl, token: held as string });
        continue;
      }
      args.say(
        `${would}mint Home's token for ${args.teamLead} on ${where}, so the Mac can ack its escalations`,
      );
      const token = args.dryRun
        ? UNMINTED
        : await mintToken(call, args.teamLead, board, HOME_FEED_LABEL);
      tokens[board] = token;
      plan.checks.push({ board, baseUrl: server.baseUrl, token });
    }
  }
  const text = `${JSON.stringify({ ...file, boardTokens: tokens }, null, 2)}\n`;
  if (text !== before && JSON.stringify(file.boardTokens ?? {}) !== JSON.stringify(tokens)) {
    plan.text = text;
  }
  return plan;
}

/** Whether the board's home feed answers the token, at the server's own address. */
export async function homeFeedAnswers(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  check: HomeFeedPlan['checks'][number],
): Promise<boolean> {
  try {
    const res = await fetchFn(
      `${check.baseUrl}/workspaces/${encodeURIComponent(check.board)}/home-feed`,
      {
        headers: { authorization: `Bearer ${check.token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      },
    );
    return res.status === 200;
  } catch {
    return false;
  }
}
