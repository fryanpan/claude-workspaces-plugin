/**
 * An attached app whose dev server stopped answering, told to the agent who
 * can start it again — once per outage.
 *
 * On 24 September an app's dev server crashed and stayed down for over two
 * hours. Every reader who opened it got an error page, the board owner asked
 * "Got bad gateway?" twice, and nothing logged the failure or woke anybody:
 * the proxy answered each request and forgot it. The fix for the reader is
 * the status in `routes/apps.ts`; this module is the fix for the agent.
 *
 * WHO IS TOLD. The agent that attached the app, from the `producedBy.agentId`
 * the attach records. An app attached before that was recorded carries only
 * `owner`, the attaching session's working directory, and no stream is keyed
 * on a directory — so it falls back to the board's lead, the one agent a
 * board always names as answerable for it. Neither known: the log line is
 * all there is, and it says so.
 *
 * ONCE PER OUTAGE. A page that fails loads a host page, and a reader who
 * refreshes loads it again, so a crash produces a failure per request per
 * reader. The first one starts the outage and wakes the agent; the rest are
 * the same news. A request that the dev server answers — whatever its status,
 * because a 404 from the app is the app running — ends the outage and re-arms
 * the notice for the next one. The state is in memory: a server restart
 * during an outage tells the agent again on the next failure, which is one
 * repeat after a deploy rather than a silence.
 */

/** The addressed frame's event name, on the board's `ws~` channel. */
export const APP_UNREACHABLE_EVENT = 'workspace.app_unreachable';

export interface AppUnreachableFrame {
  event: typeof APP_UNREACHABLE_EVENT;
  workspaceId: string;
  docId: string;
  title?: string;
  /** The loopback origin the proxy could not reach. */
  origin: string;
  /** The address readers open. */
  prefix: string;
  /** Why the fetch failed, as the runtime said it. */
  reason: string;
  /** Whether the addressee attached the app or is standing in as lead. */
  addressedAs: 'attacher' | 'lead';
  ts: number;
}

export interface AppFailure {
  workspaceId: string;
  docId: string;
  title?: string;
  origin: string;
  prefix: string;
  reason: string;
  /** `producedBy.agentId` off the app doc, when the attach recorded one. */
  attachedBy?: string;
}

export interface AppOutageDeps {
  /** The board's lead agent id, or undefined when it has none. */
  leadOf: (workspaceId: string) => string | undefined;
  /** An addressed write to one agent's streams; returns the sinks reached. */
  send: (workspaceId: string, agentId: string, frame: AppUnreachableFrame) => number;
  log?: (line: string) => void;
  now?: () => number;
}

export class AppOutages {
  /** docId → when its outage started. */
  private readonly down = new Map<string, number>();

  constructor(private readonly deps: AppOutageDeps) {}

  /** A proxy fetch to the app threw. Tells somebody only if this starts an
   *  outage; returns whether it did. */
  failed(f: AppFailure): boolean {
    if (this.down.has(f.docId)) return false;
    const ts = (this.deps.now ?? Date.now)();
    this.down.set(f.docId, ts);
    const lead = f.attachedBy ? undefined : this.deps.leadOf(f.workspaceId);
    const to = f.attachedBy ?? lead;
    const log = this.deps.log ?? console.warn;
    const what = `[apps] ${f.docId} on ${f.workspaceId} stopped answering at ${f.origin} (${f.reason})`;
    if (to === undefined) {
      log(`${what}; nobody to tell: no attacher recorded and the board has no lead`);
      return true;
    }
    const addressedAs = f.attachedBy ? 'attacher' : 'lead';
    const reached = this.deps.send(f.workspaceId, to, {
      event: APP_UNREACHABLE_EVENT,
      workspaceId: f.workspaceId,
      docId: f.docId,
      ...(f.title ? { title: f.title } : {}),
      origin: f.origin,
      prefix: f.prefix,
      reason: f.reason,
      addressedAs,
      ts,
    });
    // An addressed frame is buffered for the agent's reconnect even when no
    // stream is open, so zero is "held for replay", not "lost".
    log(
      `${what}; told ${to} (${addressedAs}${reached === 0 ? ', not listening now: held for its reconnect' : ''})`,
    );
    return true;
  }

  /** The dev server answered. Ends any outage, so the next failure tells. */
  answered(docId: string): void {
    const since = this.down.get(docId);
    if (since === undefined) return;
    this.down.delete(docId);
    const secs = Math.round(((this.deps.now ?? Date.now)() - since) / 1000);
    (this.deps.log ?? console.warn)(`[apps] ${docId} answering again after ${secs}s down`);
  }

  /** Whether the app is in an outage this process has told somebody about. */
  isDown(docId: string): boolean {
    return this.down.has(docId);
  }
}
