/**
 * Which GitHub events a board wants, and the key that may push them.
 *
 * GitHub is read in one place: the broker on Bryan's Mac, with his token. A
 * board on another machine holds no GitHub token at all. It stores a list of
 * subscriptions — a repo, and the kinds of event wanted from it — and the
 * Mac's relay (`github-relay/`) reads that list, watches those repos on the
 * broker, and posts each matching event back to the board
 * (`routes/github-hub.ts`). The board checks the event against the same list
 * before an agent hears it, so a relay with a stale copy cannot widen it.
 *
 * Kept in `<dataDir>/github-hub.json`, one record per board: its
 * subscriptions and the id of its one live push key (`auth/github-push-key.ts`).
 * The id is not a secret — without the server's key it mints nothing — and
 * the file is still written mode 600.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  githubPushKeyClaims,
  isValidGithubPushKeyId,
  mintGithubPushKey,
} from './auth/github-push-key.ts';

/** The board event an accepted push becomes, addressed to each agent on it. */
export const GITHUB_EVENT = 'workspace.github_event';

/**
 * The kinds a subscription can ask for. The broker's own lines name them:
 * CI results, review requests, mentions (with comments and assignments),
 * merged or closed pull requests, new issues, and deploy runs.
 */
export const GITHUB_EVENT_KINDS = ['ci', 'review', 'mention', 'merge', 'issue', 'deploy'] as const;
export type GithubEventKind = (typeof GITHUB_EVENT_KINDS)[number];

export interface GithubSubscription {
  /** `owner/name`, spelled as GitHub spells it. */
  repo: string;
  kinds: GithubEventKind[];
}

export interface GithubEventPush {
  /** The relay's id for the event, so a retried push is delivered once. */
  id: string;
  repo: string;
  kind: GithubEventKind;
  /** The broker's line, as written. Untrusted: anyone can title an issue. */
  text: string;
}

/** GitHub's own limits: a 39-character owner, a 100-character name. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_GITHUB_SUBSCRIPTIONS = 50;
export const GITHUB_EVENT_TEXT_MAX = 2_000;
/** Tab, newline and carriage return pass; every other control character,
 *  and the bidi overrides that reorder what a reader sees, refuse. */
export const UNSAFE_GITHUB_TEXT =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the class is the point
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
/** How many recent event ids a board remembers for its retry check. */
const SEEN_IDS = 500;

const isKind = (k: unknown): k is GithubEventKind =>
  typeof k === 'string' && (GITHUB_EVENT_KINDS as readonly string[]).includes(k);

export function isValidRepo(repo: unknown): repo is string {
  return typeof repo === 'string' && REPO.test(repo) && !repo.endsWith('.') && !repo.includes('..');
}

/** A subscription list from a request body, or the sentence refusing it. */
export function parseGithubSubscriptions(raw: unknown): GithubSubscription[] | string {
  if (!Array.isArray(raw)) return 'subscriptions must be an array';
  if (raw.length > MAX_GITHUB_SUBSCRIPTIONS) {
    return `at most ${MAX_GITHUB_SUBSCRIPTIONS} subscriptions`;
  }
  const out: GithubSubscription[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (!s || typeof s !== 'object') return 'each subscription is { repo, kinds }';
    const { repo, kinds } = s as { repo?: unknown; kinds?: unknown };
    if (!isValidRepo(repo)) return `repo must be owner/name: ${String(repo).slice(0, 80)}`;
    if (seen.has(repo.toLowerCase())) return `${repo} is listed twice`;
    seen.add(repo.toLowerCase());
    if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every(isKind)) {
      return `kinds for ${repo} must be a non-empty list of ${GITHUB_EVENT_KINDS.join(', ')}`;
    }
    out.push({ repo, kinds: GITHUB_EVENT_KINDS.filter((k) => kinds.includes(k)) });
  }
  return out;
}

/** One pushed event from a request body, or the sentence refusing it. */
export function parseGithubEventPush(raw: unknown): GithubEventPush | string {
  if (!raw || typeof raw !== 'object') return 'body must be { id, repo, kind, text }';
  const { id, repo, kind, text } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !EVENT_ID.test(id)) return 'id must be 8-64 of [A-Za-z0-9_-]';
  if (!isValidRepo(repo)) return 'repo must be owner/name';
  if (!isKind(kind)) return `kind must be one of ${GITHUB_EVENT_KINDS.join(', ')}`;
  if (typeof text !== 'string' || text.trim() === '') return 'text must be a non-empty string';
  if (text.length > GITHUB_EVENT_TEXT_MAX)
    return `text is over ${GITHUB_EVENT_TEXT_MAX} characters`;
  if (UNSAFE_GITHUB_TEXT.test(text)) return 'text carries a control or bidi-override character';
  return { id, repo, kind, text };
}

interface BoardRecord {
  subscriptions: GithubSubscription[];
  updatedAt?: number;
  keyId?: string;
  keyMintedAt?: number;
}

export function githubHubPath(dataDir: string): string {
  return join(dataDir, 'github-hub.json');
}

export class GithubHub {
  private boards: Map<string, BoardRecord> | null = null;
  private readonly seen = new Map<string, string[]>();

  constructor(
    private readonly path: string,
    private readonly key: () => string,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => randomBytes(18).toString('base64url'),
  ) {}

  private load(): Map<string, BoardRecord> {
    if (this.boards) return this.boards;
    this.boards = new Map();
    try {
      const raw = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : null;
      for (const [id, rec] of Object.entries((raw?.boards ?? {}) as Record<string, unknown>)) {
        const r = rec as Partial<BoardRecord> | null;
        const subs = parseGithubSubscriptions(r?.subscriptions ?? []);
        this.boards.set(id, {
          subscriptions: typeof subs === 'string' ? [] : subs,
          ...(typeof r?.updatedAt === 'number' ? { updatedAt: r.updatedAt } : {}),
          ...(isValidGithubPushKeyId(r?.keyId) ? { keyId: r.keyId } : {}),
          ...(typeof r?.keyMintedAt === 'number' ? { keyMintedAt: r.keyMintedAt } : {}),
        });
      }
    } catch {
      // An unreadable file is no subscriptions and no keys: every push is
      // refused until somebody mints again, which is the safe direction.
    }
    return this.boards;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const body = { boards: Object.fromEntries(this.load()) };
    writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  private record(boardId: string): BoardRecord {
    const boards = this.load();
    let r = boards.get(boardId);
    if (!r) {
      r = { subscriptions: [] };
      boards.set(boardId, r);
    }
    return r;
  }

  subscriptions(boardId: string): GithubSubscription[] {
    return (this.load().get(boardId)?.subscriptions ?? []).map((s) => ({
      ...s,
      kinds: [...s.kinds],
    }));
  }

  /** Replace the board's whole list. An empty list unsubscribes from all. */
  setSubscriptions(boardId: string, subscriptions: GithubSubscription[]): GithubSubscription[] {
    const r = this.record(boardId);
    r.subscriptions = subscriptions.map((s) => ({ ...s, kinds: [...s.kinds] }));
    r.updatedAt = this.now();
    this.save();
    return this.subscriptions(boardId);
  }

  /** A new key for the board. The value is returned once and never stored;
   *  the key it replaces stops verifying. */
  mintKey(boardId: string): { key: string; mintedAt: number } {
    const r = this.record(boardId);
    r.keyId = this.newId();
    r.keyMintedAt = this.now();
    this.save();
    return {
      key: mintGithubPushKey({ boardId, keyId: r.keyId }, this.key()),
      mintedAt: r.keyMintedAt,
    };
  }

  /** Whether the bearer is this board's live key. One answer for every
   *  failure, so a caller learns nothing about which check refused. */
  verifyKey(bearer: string | null, boardId: string): boolean {
    const claims = githubPushKeyClaims(bearer, this.key());
    if (!claims || claims.boardId !== boardId) return false;
    const keyId = this.load().get(boardId)?.keyId;
    return keyId !== undefined && keyId === claims.keyId;
  }

  /** Whether the board subscribes to this kind of event from this repo. */
  wants(boardId: string, repo: string, kind: GithubEventKind): boolean {
    const r = repo.toLowerCase();
    return this.subscriptions(boardId).some(
      (s) => s.repo.toLowerCase() === r && s.kinds.includes(kind),
    );
  }

  /** True the first time an event id is seen on a board, false on a retry. */
  firstSight(boardId: string, eventId: string): boolean {
    const ids = this.seen.get(boardId) ?? [];
    if (ids.includes(eventId)) return false;
    ids.push(eventId);
    if (ids.length > SEEN_IDS) ids.shift();
    this.seen.set(boardId, ids);
    return true;
  }
}
