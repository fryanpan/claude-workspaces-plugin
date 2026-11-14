/**
 * The agent grant: `Authorization: Bearer at3.<tokenId>.<agentId>.<appId>.<boardId>.<role>.<expiresAt>.<mac>`.
 *
 * The board-agent token's next version (`board-agent-token.ts`, `at2`), for
 * an agent that works for a person. It names one agent, one app and one
 * board, like `at2`, and adds two things `at2` cannot carry without changing
 * its frozen wire format:
 *
 * - `appId`: which server the grant is for. This server's own id comes from
 *   `CW_APP_ID` (default `workspaces`); a grant for another app does not
 *   verify here, whatever its MAC.
 * - `role`, capped by the agent's PERSON (`person-agent-link.ts`). The mint
 *   refuses an agent with no linked person and a role above that person's
 *   role on the board. Every verify re-checks it, so a grant whose person
 *   left the board, or was archived, stops verifying on its next request,
 *   and `lapsedMemberKeys` lets the server's sweep hang up what it opened.
 *
 * Signed through `signed-token.ts` under its own key domain,
 * `cw-agent-grant-token-v1`, so an `at2` value never verifies as one and this
 * one verifies as nothing else.
 *
 * Admission treats a verified grant as it treats an `at2`: a visitor scoped
 * to its one board by `collabScope` (`middleware/board-agent-door.ts`). The
 * role is `member` in this step, so owner-only writes stay refused.
 *
 * Last use is recorded on every verify, in memory, and written at most once a
 * minute per grant, so a busy agent costs no write per request. The file holds
 * no secret and is still written mode 600. A revoked record is kept, marked.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type BoardRole, normalizeBoardRole } from '../share/board-role.ts';
import { type BoardAgentClaims, boardAgentMemberKey } from './board-agent-token.ts';
import { type TokenFormat, mintToken, tokenClaims, tokenKey } from './signed-token.ts';

const VERSION = 'at3';
const TOKEN_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** The agent id rule `at2` uses: no dot, so the payload splits. */
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A board id, and an app id: the board-id character rule. */
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The app id a server answers to when `CW_APP_ID` is unset. */
export const DEFAULT_APP_ID = 'workspaces';
/** Seven days, as `at2`. */
export const AGENT_GRANT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A grant's last use is written to disk at most this often. */
export const LAST_USE_WRITE_MS = 60_000;

/** Where the request that used a grant came from. */
export type GrantVia = 'loopback' | 'edge' | 'tailnet';

const RANK: Record<BoardRole, number> = { member: 1, owner: 2 };

interface WireClaims {
  tokenId: string;
  agentId: string;
  appId: string;
  boardId: string;
  role: BoardRole;
  expiresAt: number;
}

/** What a verified grant answers: the `at2` claims, plus what it adds. */
export interface AgentGrantClaims extends BoardAgentClaims {
  version: 'at3';
  appId: string;
  role: BoardRole;
  personId: string;
}

export const agentGrantToken: TokenFormat<WireClaims> = {
  keyDomain: 'cw-agent-grant-token-v1',
  tags: [VERSION],
  encode: (c) => [VERSION, c.tokenId, c.agentId, c.appId, c.boardId, c.role, c.expiresAt].join('.'),
  decode(payload) {
    const [version, tokenId, agentId, appId, boardId, roleRaw, expiresRaw, ...rest] =
      payload.split('.');
    if (version !== VERSION || rest.length > 0) return null;
    if (!tokenId || !TOKEN_ID.test(tokenId)) return null;
    if (!agentId || !AGENT_ID.test(agentId)) return null;
    if (!appId || !BOARD_ID.test(appId)) return null;
    if (!boardId || !BOARD_ID.test(boardId)) return null;
    const role = normalizeBoardRole(roleRaw);
    if (!role) return null;
    if (!expiresRaw || !/^\d{1,15}$/.test(expiresRaw)) return null;
    const expiresAt = Number(expiresRaw);
    if (!Number.isSafeInteger(expiresAt)) return null;
    return { tokenId, agentId, appId, boardId, role, expiresAt };
  },
  expiresAt: (c) => c.expiresAt,
};

/** This format's key, derived from the one key file under its own domain. */
export function agentGrantTokenKey(cookieKey: string): string {
  return tokenKey(cookieKey, agentGrantToken);
}

export function agentGrantTokensPath(dataDir: string): string {
  return join(dataDir, 'agent-grant-tokens.json');
}

/** A configured app id, or the default when it is unset or malformed. */
export function appIdFrom(raw: string | undefined): string {
  const v = raw?.trim();
  return v && BOARD_ID.test(v) ? v : DEFAULT_APP_ID;
}

export interface AgentGrantRecord {
  id: string;
  agentId: string;
  appId: string;
  boardId: string;
  personId: string;
  role: BoardRole;
  /** Who asked for it, as the mint request said. Informational. */
  label: string;
  createdAt: number;
  refreshedAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
  lastUsedVia?: GrantVia;
}

export interface AgentGrantDeps {
  /** The app id this server answers to. */
  appId: string;
  /** The person linked to an agent, only when both sides agree. */
  personOfAgent: (agentId: string) => string | null;
  /** The person's role on the board, or null when they hold none. */
  roleOf: (boardId: string, personId: string) => BoardRole | null;
  /** Whether the person's row is active (not archived). */
  personActive: (personId: string) => boolean;
  now?: () => number;
  newId?: () => string;
}

export type AgentGrantMint =
  | { ok: true; record: AgentGrantRecord; token: string; expiresAt: number }
  | {
      ok: false;
      error:
        | 'owner_not_grantable'
        | 'agent_has_no_person'
        | 'person_not_on_board'
        | 'role_above_person';
    };

export class AgentGrantTokens {
  private records: AgentGrantRecord[] | null = null;
  /** When each grant's last use was last written. */
  private readonly usedWrittenAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly path: string,
    private readonly key: () => string,
    private readonly deps: AgentGrantDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => randomBytes(18).toString('base64url'));
  }

  /** A new grant. The value is returned once and never stored. */
  mint(
    agentId: string,
    boardId: string,
    label: string,
    role: BoardRole = 'member',
  ): AgentGrantMint {
    if (!AGENT_ID.test(agentId)) throw new Error('bad agentId');
    if (!BOARD_ID.test(boardId)) throw new Error('bad boardId');
    // An agent never holds a board's owner role, even its owner's agent:
    // owner verbs (sharing, roles, deleting the board) stay with a person.
    if (role === 'owner') return { ok: false, error: 'owner_not_grantable' };
    const personId = this.deps.personOfAgent(agentId);
    if (personId === null || !this.deps.personActive(personId)) {
      return { ok: false, error: 'agent_has_no_person' };
    }
    const held = this.deps.roleOf(boardId, personId);
    if (held === null) return { ok: false, error: 'person_not_on_board' };
    if (RANK[role] > RANK[held]) return { ok: false, error: 'role_above_person' };
    const record: AgentGrantRecord = {
      id: this.newId(),
      agentId,
      appId: this.deps.appId,
      boardId,
      personId,
      role,
      label: label.trim().slice(0, 80),
      createdAt: this.now(),
    };
    this.load().push(record);
    this.save();
    return { ok: true, record: { ...record }, ...this.sign(record) };
  }

  /**
   * The claims a bearer attests to, or null: for a forged, tampered,
   * malformed or expired value, one for another app, an id never issued, a
   * revoked one, one disagreeing with its record, and one whose person no
   * longer holds the role on the board or is archived. One answer for all.
   */
  verify(bearer: string | null, via: GrantVia = 'loopback'): AgentGrantClaims | null {
    const now = this.now();
    const claims = tokenClaims(agentGrantToken, bearer, this.key(), now);
    if (!claims || claims.appId !== this.deps.appId) return null;
    const r = this.load().find((x) => x.id === claims.tokenId);
    if (!r || r.revokedAt !== undefined) return null;
    if (
      r.agentId !== claims.agentId ||
      r.boardId !== claims.boardId ||
      r.appId !== claims.appId ||
      r.role !== claims.role
    ) {
      return null;
    }
    if (!this.withinCeiling(r)) return null;
    r.lastUsedAt = now;
    r.lastUsedVia = via;
    if (now - (this.usedWrittenAt.get(r.id) ?? Number.NEGATIVE_INFINITY) >= LAST_USE_WRITE_MS) {
      this.usedWrittenAt.set(r.id, now);
      this.save();
    }
    return {
      version: 'at3',
      tokenId: r.id,
      agentId: r.agentId,
      boardId: r.boardId,
      appId: r.appId,
      role: r.role,
      personId: r.personId,
    };
  }

  /** A fresh value for a live grant's record: same app, person and role,
   *  with the ceiling checked again. */
  refresh(grant: BoardAgentClaims): { token: string; expiresAt: number } | null {
    const r = this.load().find((x) => x.id === grant.tokenId);
    if (!r || r.revokedAt !== undefined) return null;
    if (r.agentId !== grant.agentId || r.boardId !== grant.boardId) return null;
    if (!this.withinCeiling(r)) return null;
    r.refreshedAt = this.now();
    this.save();
    return this.sign(r);
  }

  /** Whether this id is one of this store's grants. */
  has(id: string): boolean {
    return this.load().some((x) => x.id === id);
  }

  list(): AgentGrantRecord[] {
    return this.load().map((r) => ({ ...r }));
  }

  /** The record, or null when there is none. Revoking twice keeps the first time. */
  revoke(id: string): AgentGrantRecord | null {
    const r = this.load().find((x) => x.id === id);
    if (!r) return null;
    if (r.revokedAt === undefined) {
      r.revokedAt = this.now();
      this.save();
    }
    return { ...r };
  }

  /** The connection keys of live grants whose person no longer holds the
   *  role or is archived, for the server's sweep to hang up. */
  lapsedMemberKeys(): string[] {
    return this.load()
      .filter((r) => r.revokedAt === undefined && !this.withinCeiling(r))
      .map((r) => boardAgentMemberKey(r.boardId, r.id));
  }

  private withinCeiling(r: AgentGrantRecord): boolean {
    if (!this.deps.personActive(r.personId)) return false;
    if (this.deps.personOfAgent(r.agentId) !== r.personId) return false;
    const held = this.deps.roleOf(r.boardId, r.personId);
    return held !== null && r.role !== 'owner' && RANK[r.role] <= RANK[held];
  }

  private sign(r: AgentGrantRecord): { token: string; expiresAt: number } {
    const expiresAt = this.now() + AGENT_GRANT_TOKEN_TTL_MS;
    const claims: WireClaims = {
      tokenId: r.id,
      agentId: r.agentId,
      appId: r.appId,
      boardId: r.boardId,
      role: r.role,
      expiresAt,
    };
    return { token: mintToken(agentGrantToken, claims, this.key()), expiresAt };
  }

  private load(): AgentGrantRecord[] {
    if (this.records) return this.records;
    try {
      const raw = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : null;
      const list: unknown[] = Array.isArray(raw?.tokens) ? raw.tokens : [];
      this.records = list.filter(isRecord);
    } catch {
      this.records = [];
    }
    return this.records;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tokens: this.load() }, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

function isRecord(r: unknown): r is AgentGrantRecord {
  if (!r || typeof r !== 'object') return false;
  const x = r as Partial<AgentGrantRecord>;
  return (
    typeof x.id === 'string' &&
    TOKEN_ID.test(x.id) &&
    typeof x.agentId === 'string' &&
    AGENT_ID.test(x.agentId) &&
    typeof x.appId === 'string' &&
    BOARD_ID.test(x.appId) &&
    typeof x.boardId === 'string' &&
    BOARD_ID.test(x.boardId) &&
    typeof x.personId === 'string' &&
    normalizeBoardRole(x.role) !== undefined
  );
}
