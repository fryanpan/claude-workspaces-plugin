/**
 * The board server's side of "a keeper request shows on Bryan's Home": one
 * owner-only card per request that waits for his passkey, withdrawn once the
 * request stops waiting.
 *
 * A keeper client posts the request's id and poll token here
 * (`keeper-announce.ts`). That post is a claim from any process on this
 * machine, so nothing is filed on it alone. The server asks the keeper, with
 * that poll token and its own caller token, whether the request is pending,
 * and the card is written from the keeper's answer: its kind and its summary,
 * never the poster's words beyond the requester's name. The approval link is
 * built here from the keeper's own origin and the id, so a forged post gets
 * no card, and a real one can only send Bryan to the keeper's own page.
 *
 * The card only carries Bryan to that page. The keeper's passkey is tied to
 * `localhost` (`webauthn.ts`), so the page opens on the Mac. Answering the
 * card approves nothing. It is filed `ownerOnly`, so no agent, share visitor
 * or mock page can answer it either (`refuseOwnerOnlyWrite`).
 *
 * The server then asks the keeper again every `POLL_MS` and withdraws the card
 * once the request is running, done, denied, withdrawn or expired, or once
 * the keeper no longer knows it. Each open card's poll token is kept in
 * `keeper-cards.json`, mode 600, so a restart keeps watching it. The polls run
 * only while a card is open, and each is bounded by `ASK_MS`: one the keeper
 * never answered used to hold the sweep for good, which left every card on
 * Home after its request had finished.
 *
 * The cards sit on one standing task on the owner's catch-all board, or on
 * the best live board when that one is retired, as the sharing notice does
 * (`sharing-notice.ts`).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuredHostFetch } from '../outbound-fetch.ts';
import { CALLER_HEADER, callerTokenPath, readCallerToken } from './keeper-callers.ts';
import { KEEPER_URL_ENV } from './keeper-client.ts';
import { API_HEADER } from './keeper-http.ts';
import { PENDING_MS } from './keeper-requests.ts';

export const KEEPER_CARDS_FILENAME = 'keeper-cards.json';
export const KEEPER_CARD_ACTOR = { id: 'agent-workspaces-keeper', name: 'Keeper', kind: 'agent' };
export const KEEPER_CARD_TASK_TITLE = 'Keeper requests waiting for your passkey';

const ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * How often an open card asks the keeper. The card must leave an open Home
 * within 1s of the approval, and this is the one part of that budget a poll
 * chooses: 250 here, 250 for `LANDING_COALESCE_MS`, 100 for the page's own
 * debounce, and what is left for the page to re-read `/`.
 */
const POLL_MS = 250;
/** How long one poll may take. Past it the keeper counts as not answering. */
const ASK_MS = 2000;

/** What the keeper answers a poll with. */
interface KeeperView {
  status: string;
  hold?: string;
  summary?: string;
}

type Actor = { id: string; name: string; kind?: string };

export interface KeeperHomeCardDeps {
  dataDir: string;
  keeper: {
    /** `CW_KEEPER_URL`. */
    origin: string;
    /** The caller token the keeper's agent API needs. */
    callerToken: () => string | null;
    fetchImpl?: typeof fetch;
    pollMs?: number;
    askMs?: number;
  };
  /** Boards to file on, best first; the first that takes the task wins. */
  boards: () => string[];
  isBoardLive: (workspaceId: string) => boolean;
  getTask(taskId: string): { id: string; workspaceId: string; archivedAt?: number } | undefined;
  createTask(
    workspaceId: string,
    opts: { title: string; body: string; goal: string; actor: Actor },
  ): { ok: true; task: { id: string } } | { ok: false; error?: string };
  addReviewItem(
    taskId: string,
    review: unknown,
    opts: { actor: Actor },
  ): { ok: true; item: { id: string } } | { ok: false; error: string };
  withdrawReviewItem(
    taskId: string,
    itemId: string,
    opts: { actor: Actor; reason: string },
  ): { ok: boolean };
  now?: () => number;
  say?: (line: string) => void;
}

interface OpenCard {
  pollToken: string;
  taskId: string;
  itemId: string;
  at: number;
}

interface CardState {
  taskId?: string;
  open: Record<string, OpenCard>;
}

export type AnnounceResult =
  | { status: 201 | 200; itemId: string }
  | { status: 400 | 404 | 409 | 502; error: string };

const HOLD_WORDS: Record<string, string> = {
  'project.create': 'create a project',
  'token.move': 'move a credential',
  'access.open': 'open an Access application',
  'move.grant': 'move a board',
  'cloudflare.apply': 'apply a Cloudflare change',
};

/**
 * One line of text that cannot leave a fenced block or a code span: control
 * and format characters (bidirectional overrides among them) and backticks
 * become spaces.
 */
const plain = (s: string, max: number): string =>
  s
    .replace(/[\p{Cc}\p{Cf}`]/gu, ' ')
    .trim()
    .slice(0, max);

/** The card's words. Exported so a test asserts what it carries. */
export function keeperCardReview(input: {
  approveUrl: string;
  hold: string;
  summary: string;
  requester: string;
}): Record<string, unknown> {
  const what = HOLD_WORDS[input.hold] ?? 'run a held command';
  const who = plain(input.requester, 120) || 'A program on the Mac';
  return {
    review_type: 'question',
    headline: `The keeper waits for your passkey to ${what}`,
    detail: [
      `\`${who}\` asked the keeper for this. It runs only after your passkey approves it:`,
      `\`\`\`text\n${plain(input.summary, 300)}\n\`\`\``,
      `[Open the approval page on the Mac](${input.approveUrl})`,
      'Your passkey belongs to the Mac, so the page opens there and not on the iPad. The page shows the exact command; approve or deny it there. This card goes away by itself once the request is approved, denied, withdrawn or expired.',
    ].join('\n\n'),
    ownerOnly: true,
  };
}

/**
 * The keeper the board server tells Home about, when `CW_KEEPER_URL` names
 * one. The caller token is read on each poll, so a token the setup rotates
 * is picked up without a restart.
 */
export function keeperHoldsFromEnv(
  env: Record<string, string | undefined>,
): { origin: string; callerToken: () => string | null } | undefined {
  const origin = env[KEEPER_URL_ENV]?.trim();
  if (!origin) return undefined;
  return {
    origin,
    callerToken: () => {
      const read = readCallerToken(callerTokenPath(env));
      return 'token' in read ? read.token : null;
    },
  };
}

export class KeeperHomeCards {
  private readonly path: string;
  private state: CardState;
  private readonly say: (line: string) => void;
  private readonly now: () => number;
  private readonly doFetch: typeof fetch;
  /** The keeper's page origin: `localhost`, which the passkey is tied to. */
  private readonly pageOrigin: string;
  private readonly origin: string;
  private readonly inflight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  /** Whether the keeper's silence has been logged, so a poll logs it once. */
  private silent = false;

  constructor(private readonly deps: KeeperHomeCardDeps) {
    this.path = join(deps.dataDir, KEEPER_CARDS_FILENAME);
    this.say = deps.say ?? ((line) => console.error(line));
    this.now = deps.now ?? Date.now;
    const url = new URL(deps.keeper.origin);
    this.origin = url.origin;
    this.pageOrigin = `http://localhost:${url.port}`;
    this.doFetch = deps.keeper.fetchImpl ?? configuredHostFetch([this.origin]);
    this.state = this.load();
    if (Object.keys(this.state.open).length > 0) this.arm();
  }

  /** The open cards, by keeper request id, for a test or a status read. */
  openCards(): Record<string, { taskId: string; itemId: string }> {
    return Object.fromEntries(
      Object.entries(this.state.open).map(([id, c]) => [
        id,
        { taskId: c.taskId, itemId: c.itemId },
      ]),
    );
  }

  /** A client says request `id` waits for a tap. */
  async announce(input: {
    id: unknown;
    pollToken: unknown;
    requester: unknown;
  }): Promise<AnnounceResult> {
    const { id, pollToken } = input;
    if (typeof id !== 'string' || !ID.test(id))
      return { status: 400, error: 'id is not a request id' };
    if (typeof pollToken !== 'string' || !ID.test(pollToken)) {
      return { status: 400, error: 'pollToken is not a poll token' };
    }
    const requester = typeof input.requester === 'string' ? input.requester : '';
    const known = this.state.open[id];
    if (known) return { status: 200, itemId: known.itemId };
    if (this.inflight.has(id)) return { status: 409, error: 'this request is being filed' };
    this.inflight.add(id);
    try {
      const view = await this.ask(id, pollToken);
      if (view === 'unreachable') return { status: 502, error: 'the keeper did not answer' };
      if (view === null) return { status: 404, error: 'the keeper has no such request' };
      if (view.status !== 'pending') {
        return { status: 409, error: `the request is ${view.status}, not waiting` };
      }
      const taskId = this.ensureTask();
      if (!taskId) return { status: 502, error: 'no board took the card' };
      const review = keeperCardReview({
        approveUrl: `${this.pageOrigin}/approve/${id}`,
        hold: view.hold ?? 'other',
        summary: view.summary ?? '',
        requester,
      });
      const res = this.deps.addReviewItem(taskId, review, { actor: { ...KEEPER_CARD_ACTOR } });
      if (!res.ok) {
        this.say(`[keeper] Home card refused task=${taskId}: ${res.error}`);
        return { status: 502, error: `the card was refused: ${res.error}` };
      }
      this.state.open[id] = { pollToken, taskId, itemId: res.item.id, at: this.now() };
      this.save();
      this.arm();
      return { status: 201, itemId: res.item.id };
    } finally {
      this.inflight.delete(id);
    }
  }

  /** Ask the keeper about every open card once, and withdraw the settled. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const asked = await Promise.all(
        Object.entries(this.state.open).map(async ([id, card]) => {
          const view = await this.ask(id, card.pollToken);
          if (view === 'unreachable') {
            // A keeper that is down may come back; a card past the keeper's
            // own lifetime for a request cannot still be waiting.
            if (this.now() - card.at > PENDING_MS) this.withdraw(id, 'The request expired.');
            return false;
          }
          if (view === null) this.withdraw(id, 'The keeper no longer has this request.');
          else if (view.status !== 'pending') this.withdraw(id, `The request is ${view.status}.`);
          return true;
        }),
      );
      const silent = asked.includes(false);
      if (silent && !this.silent) {
        this.say('[keeper] the keeper did not answer a poll, so Home cards stay until it does');
      }
      this.silent = silent;
    } finally {
      this.sweeping = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (Object.keys(this.state.open).length === 0) return this.stop();
      void this.sweep();
    }, this.deps.keeper.pollMs ?? POLL_MS);
  }

  private withdraw(id: string, reason: string): void {
    const card = this.state.open[id];
    if (!card) return;
    const res = this.deps.withdrawReviewItem(card.taskId, card.itemId, {
      actor: { ...KEEPER_CARD_ACTOR },
      reason,
    });
    if (!res.ok) this.say(`[keeper] Home card ${card.itemId} was not withdrawn: ${reason}`);
    delete this.state.open[id];
    this.save();
  }

  /** The keeper's view of one request: null when it has none by that id and token. */
  private async ask(id: string, pollToken: string): Promise<KeeperView | null | 'unreachable'> {
    const token = this.deps.keeper.callerToken();
    try {
      const res = await this.doFetch(`${this.origin}/v1/requests/${id}`, {
        headers: {
          [API_HEADER]: '1',
          ...(token ? { [CALLER_HEADER]: token } : {}),
          'x-cw-keeper-poll': pollToken,
        },
        signal: AbortSignal.timeout(this.deps.keeper.askMs ?? ASK_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) return 'unreachable';
      const view = (await res.json()) as KeeperView;
      return typeof view.status === 'string' ? view : 'unreachable';
    } catch {
      return 'unreachable';
    }
  }

  private ensureTask(): string | null {
    const known = this.state.taskId ? this.deps.getTask(this.state.taskId) : undefined;
    if (known && known.archivedAt === undefined && this.deps.isBoardLive(known.workspaceId)) {
      return known.id;
    }
    for (const workspaceId of this.deps.boards()) {
      const created = this.deps.createTask(workspaceId, {
        title: KEEPER_CARD_TASK_TITLE,
        body: 'Where the server puts each keeper request that waits for your passkey, with a link to its approval page on the Mac. Each card withdraws itself once its request stops waiting.',
        goal: 'chores',
        actor: { ...KEEPER_CARD_ACTOR },
      });
      if (created.ok) {
        this.state.taskId = created.task.id;
        this.save();
        return created.task.id;
      }
      this.say(
        `[keeper] Home card task refused on board ${JSON.stringify(workspaceId)}: ${created.error ?? 'unknown'}`,
      );
    }
    this.say('[keeper] Home card filed nowhere: every board refused the task');
    return null;
  }

  private load(): CardState {
    if (!existsSync(this.path)) return { open: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CardState>;
      const open: Record<string, OpenCard> = {};
      for (const [id, c] of Object.entries(parsed.open ?? {})) {
        if (
          ID.test(id) &&
          typeof c?.pollToken === 'string' &&
          typeof c.taskId === 'string' &&
          typeof c.itemId === 'string' &&
          typeof c.at === 'number'
        ) {
          open[id] = c;
        }
      }
      return { ...(typeof parsed.taskId === 'string' ? { taskId: parsed.taskId } : {}), open };
    } catch {
      return { open: {} };
    }
  }

  private save(): void {
    writeFileSync(this.path, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}
