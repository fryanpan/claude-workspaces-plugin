/**
 * The relay: carries agent messages between project servers, applying the
 * organization rule and the filter on the way.
 *
 * A lead never holds another project's token; the relay does, as its own
 * process (and, on the Mac, its own macOS user). A seat sends by opening a
 * thread on its outbox doc, on its own board, whose first line is
 * `to: <seat id>` and whose remaining lines are the message. The relay reads
 * each outbox with that server's credentials, so the SENDER is the seat that
 * owns the outbox the thread was found on and whose agent id opened it,
 * never a name the message carries. A lead posts with its own board-scoped
 * token (`at2`), and the server records the token's agent as the author
 * whatever the body claims, so another agent on the board cannot open a
 * thread on a lead's outbox as that lead. A caller on the server's machine
 * that presents no token is trusted-local and its claimed author stands, so
 * the author id is not enough: the relay also needs the server's record that
 * the seat's own token, for the seat's board, opened the thread (`openerProof`,
 * `thread-opener-proofs.ts`).
 *
 * Each message ends in exactly one of three verdicts, every one logged
 * without its body (`relay-log.ts`):
 *
 *  - **refused**: unknown seat, empty, too long, or across organizations
 *    from a seat without cross-organization access.
 *  - **held**: it needed the filter (from another organization, or from a
 *    seat marked untrusted) and a fixed check tripped, the classifier
 *    flagged it, the classifier failed or timed out, or there is no
 *    classifier. Held messages wait for Bryan in the hold queue and never
 *    reach the lead until he releases one.
 *  - **delivered**: posted on the recipient's inbox doc as quoted data,
 *    marked with the sender's seat and organization.
 *
 * A delivery that fails in transit gets no verdict and is tried again on the
 * next pass, so a recipient server that is down loses nothing.
 */
import { BOARD_AGENT_TOKEN_TTL_MS } from '../auth/board-agent-token.ts';
import { createBearerKeeper } from './relay-bearers.ts';
import {
  type OutboxThread,
  type RelayFetch,
  deliverToInbox,
  readOutbox,
  replyOnOutbox,
} from './relay-client.ts';
import type { RelayConfig, RelaySeat } from './relay-config.ts';
import type { RelayFilter } from './relay-filter.ts';
import type { RelayStore, RelayVerdict } from './relay-log.ts';
import { applyOrganizationRule, deliveredText, fixedCheckHit } from './relay-rule.ts';

export interface RelayMessage {
  id: string;
  from: string;
  to: string;
  text: string;
}

export type RelayOutcome =
  | { verdict: Exclude<RelayVerdict, 'released'>; reason?: string }
  | { verdict: 'failed'; reason: string };

export interface RelayOptions {
  config: RelayConfig;
  store: RelayStore;
  /** null: no classifier, so every message that needs one is held. */
  filter: RelayFilter | null;
  fetch?: RelayFetch;
  filterTimeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Where renewed board tokens are kept (`relay-bearers.ts`); null keeps
   *  them in memory. */
  stateDir?: string | null;
}

export interface Relay {
  /** Decide and carry one message whose sender the caller has attested. */
  handle(message: RelayMessage): Promise<RelayOutcome>;
  /** Read every outbox once and handle each new message. */
  pollOnce(): Promise<void>;
  /** Deliver a held message Bryan released. */
  release(id: string): Promise<'released' | 'not-held' | 'refused' | 'failed'>;
}

const TO_LINE = /^\s*to:\s*([A-Za-z0-9_-]{1,128})\s*$/i;

/** `to: <seat>` then the message, or null when the thread is not one. */
export function parseOutboxText(text: string): { to: string; text: string } | null {
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  const m = TO_LINE.exec(first);
  if (!m) return null;
  return { to: m[1] as string, text: nl < 0 ? '' : text.slice(nl + 1).trim() };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('relay filter timed out')), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

export function createRelay(opts: RelayOptions): Relay {
  const { config, store } = opts;
  const fetchFn: RelayFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.error(line));
  const filterTimeoutMs = opts.filterTimeoutMs ?? 15_000;
  const handled = store.handledIds();
  /** Ids whose delivery failed in transit and was already logged once. */
  const failedOnce = new Set<string>();
  /** Ids the filter passed whose delivery failed: a retry is not judged again. */
  const passed = new Set<string>();
  let polling = false;
  const bearers = createBearerKeeper({
    fetch: fetchFn,
    config,
    stateDir: opts.stateDir ?? null,
    ttlMs: BOARD_AGENT_TOKEN_TTL_MS,
    now,
    log,
  });

  const record = (
    m: RelayMessage,
    verdict: RelayVerdict,
    from: RelaySeat | undefined,
    to: RelaySeat | undefined,
    reason?: string,
  ) => {
    store.append({
      ts: now(),
      id: m.id,
      from: m.from,
      to: m.to,
      fromOrganization: from?.organization ?? null,
      toOrganization: to?.organization ?? null,
      verdict,
      ...(reason ? { reason } : {}),
    });
    handled.add(m.id);
  };

  /**
   * Why a filtered message must be held, or null to deliver it. `logged` is
   * what the log may say; `detail` is the classifier's own sentence, which
   * may quote the message and so goes only into the hold queue.
   */
  async function holdReason(
    m: RelayMessage,
    from: RelaySeat,
    to: RelaySeat,
  ): Promise<{ logged: string; detail: string } | null> {
    const hit = fixedCheckHit(m.text);
    if (hit) return { logged: `fixed-check:${hit}`, detail: `fixed-check:${hit}` };
    if (!opts.filter) return { logged: 'no-filter', detail: 'no-filter' };
    try {
      const verdict = await withTimeout(
        opts.filter({
          text: m.text,
          fromSeat: from.id,
          fromOrganization: from.organization,
          toSeat: to.id,
          toOrganization: to.organization,
        }),
        filterTimeoutMs,
      );
      return verdict.hold ? { logged: 'filter-flagged', detail: verdict.reason } : null;
    } catch {
      return { logged: 'filter-unavailable', detail: 'filter-unavailable' };
    }
  }

  async function deliver(m: RelayMessage, from: RelaySeat, to: RelaySeat, cross: boolean) {
    const server = config.servers.get(to.server);
    if (!server) return false;
    return deliverToInbox(
      fetchFn,
      server,
      to.board,
      to.inboxDoc,
      deliveredText(from, cross, m.text),
      `relay-${m.id}`,
    );
  }

  async function handle(m: RelayMessage): Promise<RelayOutcome> {
    if (handled.has(m.id)) return { verdict: 'refused', reason: 'duplicate' };
    const rule = applyOrganizationRule(config, m.from, m.to, m.text);
    if (rule.kind === 'refuse') {
      record(m, 'refused', config.seats.get(m.from), config.seats.get(m.to), rule.reason);
      return { verdict: 'refused', reason: rule.reason };
    }
    const { from, to, crossOrganization } = rule;
    if (rule.filter && !passed.has(m.id)) {
      const reason = await holdReason(m, from, to);
      if (reason) {
        store.hold({
          ts: now(),
          id: m.id,
          from: m.from,
          to: m.to,
          reason: reason.detail,
          text: m.text,
        });
        record(m, 'held', from, to, reason.logged);
        return { verdict: 'held', reason: reason.logged };
      }
      passed.add(m.id);
    }
    if (!(await deliver(m, from, to, crossOrganization))) {
      if (!failedOnce.has(m.id)) log(`[relay] delivery of ${m.id} to ${to.id} failed; will retry`);
      failedOnce.add(m.id);
      return { verdict: 'failed', reason: 'delivery-failed' };
    }
    passed.delete(m.id);
    record(m, 'delivered', from, to);
    return { verdict: 'delivered' };
  }

  function outcomeText(outcome: RelayOutcome, to: string): string {
    switch (outcome.verdict) {
      case 'delivered':
        return `Relay: delivered to ${to}.`;
      case 'held':
        return `Relay: held for Bryan before delivery to ${to}.`;
      case 'refused':
        return `Relay: refused (${outcome.reason ?? 'refused'}).`;
      default:
        return '';
    }
  }

  async function pollSeat(seat: RelaySeat): Promise<void> {
    const server = config.servers.get(seat.server);
    if (!server) return;
    const threads = await readOutbox(fetchFn, server, seat.board, seat.outboxDoc);
    if (!threads) return;
    for (const thread of threads) await handleThread(seat, thread);
  }

  async function handleThread(seat: RelaySeat, thread: OutboxThread): Promise<void> {
    const id = `${seat.id}:${thread.id}`;
    if (handled.has(id)) return;
    const opener = thread.comments[0];
    // Only the seat's own agent sends from its outbox, and only with its own
    // board token for the seat's board: the server's opener proof, not the
    // author id, which a loopback caller without a token can claim. A thread
    // anybody else opened there is left alone, unlogged; it is not a message.
    const proof = thread.openerProof;
    if (!opener || thread.createdById !== seat.agentId || opener.authorId !== seat.agentId) return;
    if (proof?.agentId !== seat.agentId || proof.boardId !== seat.board) return;
    const parsed = parseOutboxText(opener.text);
    if (!parsed) return;
    const server = config.servers.get(seat.server);
    const outcome = await handle({ id, from: seat.id, to: parsed.to, text: parsed.text });
    const reply = outcomeText(outcome, parsed.to);
    if (reply && server) {
      await replyOnOutbox(fetchFn, server, seat.board, seat.outboxDoc, thread.id, reply);
    }
  }

  return {
    handle,
    async pollOnce() {
      if (polling) return;
      polling = true;
      try {
        await bearers.run();
        for (const seat of config.seats.values()) await pollSeat(seat);
      } finally {
        polling = false;
      }
    },
    async release(id) {
      const held = store.pending().find((h) => h.id === id);
      if (!held) return 'not-held';
      // The rule is asked again: a seat whose access was withdrawn since
      // the hold does not get its message through by a release.
      const rule = applyOrganizationRule(config, held.from, held.to, held.text);
      if (rule.kind === 'refuse') return 'refused';
      const { from, to } = rule;
      const ok = await deliver(held, from, to, rule.crossOrganization);
      if (!ok) return 'failed';
      store.append({
        ts: now(),
        id: held.id,
        from: held.from,
        to: held.to,
        fromOrganization: from.organization,
        toOrganization: to.organization,
        verdict: 'released',
      });
      return 'released';
    },
  };
}
