/**
 * The board-scoped agent bearer:
 * `Authorization: Bearer at2.<tokenId>.<agentId>.<boardId>.<mac>`.
 *
 * An agent on another machine — Team Lead, or the relay — reaches one board
 * on this server through the tunnel. The Access service token in front of the
 * hostname proves the caller was admitted to the hostname; it names no
 * person, no agent and no board. This token is the second half: it names the
 * one agent the request speaks for and the one board it may open.
 *
 * What it opens is decided in `request-admission.ts`, not here: the caller is
 * admitted as a visitor scoped to its board, judged by `collabScope` — the
 * same allowlist a board member is judged by, so Mac paths, mounts, deploy,
 * sharing and every other board stay refused by the lines that already refuse
 * a member — plus its own watch set, filtered to that board.
 *
 * Signed through `signed-token.ts` under its own key domain, so no other
 * protocol's value verifies as one and this one verifies as nothing else.
 *
 * Revocable one at a time. The MAC proves this server minted the id; the
 * record proves it still stands, and still names the same agent and board
 * the token does. The file holds no secret — an id without the key mints
 * nothing — and is still written mode 600. A revoked record is kept, marked,
 * never deleted.
 *
 * No expiry, for the reason `agent-token.ts` gives: the holder keeps it for
 * the life of a session and has no re-mint path from off the machine.
 * Revocation is the record.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type TokenFormat, mintToken, tokenClaims, tokenKey } from './signed-token.ts';

const VERSION = 'at2';
const TOKEN_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** An agent id, as `isValidAgentId` spells it. No dot, so the payload splits. */
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A board id. No dot, for the same reason. */
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface BoardAgentClaims {
  /** The record that must still stand for this token to verify. */
  tokenId: string;
  /** The one agent a write through this token is attributed to. */
  agentId: string;
  /** The one board this token opens. */
  boardId: string;
}

export const boardAgentToken: TokenFormat<BoardAgentClaims> = {
  keyDomain: 'cw-board-agent-token-v1',
  tags: [VERSION],
  encode: (c) => [VERSION, c.tokenId, c.agentId, c.boardId].join('.'),
  decode(payload) {
    const [version, tokenId, agentId, boardId, ...rest] = payload.split('.');
    if (version !== VERSION || rest.length > 0) return null;
    if (!tokenId || !TOKEN_ID.test(tokenId)) return null;
    if (!agentId || !AGENT_ID.test(agentId)) return null;
    if (!boardId || !BOARD_ID.test(boardId)) return null;
    return { tokenId, agentId, boardId };
  },
  expiresAt: () => null,
};

/** This format's key, derived from the one key file under its own domain. */
export function boardAgentTokenKey(cookieKey: string): string {
  return tokenKey(cookieKey, boardAgentToken);
}

/** Whether a board id has the shape a token can carry. */
export function isValidBoardId(id: unknown): id is string {
  return typeof id === 'string' && BOARD_ID.test(id);
}

/** Whether a token id has the shape the record keeps. */
export function isValidBoardTokenId(id: unknown): id is string {
  return typeof id === 'string' && TOKEN_ID.test(id);
}

/** The `at2` bearer this request carries, or null. Shape-matched, so a
 *  bearer for another protocol is never offered to this verifier. */
export function boardAgentBearerOf(headers: Headers): string | null {
  const raw = headers.get('authorization');
  const m = raw?.match(/^Bearer\s+(at2\.[^\s]+)$/i);
  return m?.[1] ?? null;
}

/**
 * The key stamped on every socket and stream an `at2` request opens, in the
 * `shareMember` field a membership key uses. The board comes first, so the
 * board lock's sweep (`memberKeyOnBoard`) hangs these up with the members';
 * the token id comes last, so revoking one token hangs up only its own.
 */
export function boardAgentMemberKey(boardId: string, tokenId: string): string {
  return `${boardId}\u0000at2\u0000${tokenId}`;
}

export interface BoardTokenRecord {
  id: string;
  agentId: string;
  boardId: string;
  /** Who asked for it, as the mint request said. Informational. */
  label: string;
  createdAt: number;
  revokedAt?: number;
}

export function boardTokensPath(dataDir: string): string {
  return join(dataDir, 'board-agent-tokens.json');
}

export class BoardAgentTokens {
  private records: BoardTokenRecord[] | null = null;

  constructor(
    private readonly path: string,
    private readonly key: () => string,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => randomBytes(18).toString('base64url'),
  ) {}

  private load(): BoardTokenRecord[] {
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

  /** A new token. The value is returned once and never stored. */
  mint(
    agentId: string,
    boardId: string,
    label: string,
  ): { record: BoardTokenRecord; token: string } {
    if (!AGENT_ID.test(agentId)) throw new Error('bad agentId');
    if (!BOARD_ID.test(boardId)) throw new Error('bad boardId');
    const record: BoardTokenRecord = {
      id: this.newId(),
      agentId,
      boardId,
      label: label.trim().slice(0, 80),
      createdAt: this.now(),
    };
    this.load().push(record);
    this.save();
    const claims = { tokenId: record.id, agentId, boardId };
    return { record: { ...record }, token: mintToken(boardAgentToken, claims, this.key()) };
  }

  list(): BoardTokenRecord[] {
    return this.load().map((r) => ({ ...r }));
  }

  /** The record, or null when there is none. Revoking twice keeps the first
   *  time. */
  revoke(id: string): BoardTokenRecord | null {
    const r = this.load().find((x) => x.id === id);
    if (!r) return null;
    if (r.revokedAt === undefined) {
      r.revokedAt = this.now();
      this.save();
    }
    return { ...r };
  }

  /**
   * The claims a bearer attests to, or null. Null for a forged, tampered or
   * malformed value, for an id the record never issued, for a revoked one, and
   * for a token whose agent or board disagrees with its record — every one the
   * same answer, so a caller learns nothing about which check refused.
   */
  verify(bearer: string | null): BoardAgentClaims | null {
    const claims = tokenClaims(boardAgentToken, bearer, this.key());
    if (!claims) return null;
    const r = this.load().find((x) => x.id === claims.tokenId);
    if (!r || r.revokedAt !== undefined) return null;
    if (r.agentId !== claims.agentId || r.boardId !== claims.boardId) return null;
    return claims;
  }
}

function isRecord(r: unknown): r is BoardTokenRecord {
  if (!r || typeof r !== 'object') return false;
  const x = r as Partial<BoardTokenRecord>;
  return (
    typeof x.id === 'string' &&
    TOKEN_ID.test(x.id) &&
    typeof x.agentId === 'string' &&
    AGENT_ID.test(x.agentId) &&
    typeof x.boardId === 'string' &&
    BOARD_ID.test(x.boardId)
  );
}
