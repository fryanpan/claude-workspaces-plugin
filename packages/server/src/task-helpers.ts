/**
 * Pure per-store helpers with no state of their own: the nested-goal payload
 * shape a caller or an old sidecar may still send, and the attachment-runtime
 * check. Split out of `tasks.ts` for the same reason `task-fields.ts` and
 * `task-owner.ts` already are — `task-persistence.ts` needs both and may not
 * import a VALUE from the file that imports it, the same rule `task-agents.ts`
 * and `workspace-store.ts` follow for their own pure helpers. `tasks.ts`
 * imports them back and re-exports them, so no caller outside either file
 * changes.
 *
 * The verb-family split added the four those modules need, for the same reason:
 * `task-authoring.ts` mints a status with `initialTaskStatus`,
 * `task-lifecycle.ts` reads the row discriminator with `isGoalRow`, and
 * `task-links.ts` validates and keys every `Ref` — three predicates that were
 * already pure, already exported, and already had no reader inside the store
 * class. The done-when proof reader sits beside `isSafeHttpUrl`, the guard it
 * shares with a `url` ref.
 */
import type { DoneWhenProof } from '@claude-workspaces/core/done-when';
import type { TaskStatus } from '@claude-workspaces/core/task-wire';
import { classifyActor } from './actor-identity.ts';
import type { GoalRow, Ref, WorkspaceGoal } from './tasks.ts';

export type AttachmentRuntime = 'claude-code-local' | 'managed-agent' | 'webhook';

const ATTACHMENT_RUNTIMES: ReadonlySet<string> = new Set([
  'claude-code-local',
  'managed-agent',
  'webhook',
]);

export function isAttachmentRuntime(v: unknown): v is AttachmentRuntime {
  return typeof v === 'string' && ATTACHMENT_RUNTIMES.has(v);
}

/**
 * A goal list as it may arrive from OUTSIDE — a payload written before
 * subgoals were removed, or a workspace on disk that still holds them.
 *
 * Subgoals are gone from the product (Bryan, 2026-08-30: *"We no longer
 * support subgoals. If there's any code left for subgoals remove it"*), but
 * a stored board is not rewritten by that decision. `flattenNestedGoals` is
 * the one door such a payload comes through, and every one of them arrives
 * flat on the other side.
 */
export interface NestedGoalInput {
  id: string;
  title: string;
  dueAt?: number;
  subgoals?: NestedGoalInput[];
}

/**
 * Splice any nested goals into the top level, each one landing directly after
 * the parent that held it.
 *
 * That position is not a choice: the board has drawn subgoals as flat rows in
 * exactly this order all along, so a flattened list looks like the board the
 * reader already had. Depth beyond one level was never written, but the walk
 * is recursive anyway — a payload that has it should still load rather than
 * lose rows.
 */
export function flattenNestedGoals(goals: readonly NestedGoalInput[]): WorkspaceGoal[] {
  const out: WorkspaceGoal[] = [];
  const walk = (list: readonly NestedGoalInput[]) => {
    for (const g of list) {
      out.push({ id: g.id, title: g.title, ...(g.dueAt !== undefined ? { dueAt: g.dueAt } : {}) });
      if (g.subgoals?.length) walk(g.subgoals);
    }
  };
  walk(goals);
  return out;
}

/** Schemes a `url` ref may carry. A ref is rendered as a clickable chip, so
 *  the value becomes an href — `javascript:` and `data:` are script injection
 *  and `file:` reads the host. Every other kind is an internal id and cannot
 *  express a scheme at all, which is why this check has no analogue there.
 *
 *  Exported because a done-when proof carries a url for the same reason and
 *  becomes an href in the same way — one guard, so the two surfaces cannot
 *  disagree about what is safe to click. */
export function isSafeHttpUrl(value: string): boolean {
  // No trimming first, deliberately: a leading space would make `new URL`
  // parse `  javascript:…` fine in some runtimes, and a caller sending
  // padded input is not a caller whose padding we should silently fix.
  if (value !== value.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  // `URL.protocol` is already lowercased by the parser, so a mixed-case
  // scheme can't slip past this comparison.
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * A done-when proof url as it is stored, or `'needs-base'`.
 *
 * An absolute http(s) url is kept. A board path — one leading "/", the shape
 * an agent copies off the board, `/workspaces/<id>?task=<id>` — is resolved
 * against `baseUrl`, the base the server builds every review link on, because
 * a link the reader cannot open is the failure the owner check exists to end:
 * it used to be dropped here without a word. With no base to resolve it
 * against the answer is `'needs-base'`, so the caller refuses rather than
 * drops. Anything else is dropped, as before.
 */
export function resolveProofUrl(
  value: string,
  baseUrl: string | undefined,
): string | undefined | 'needs-base' {
  if (isSafeHttpUrl(value)) return value;
  if (value !== value.trim() || !value.startsWith('/')) return undefined;
  if (baseUrl === undefined) return 'needs-base';
  try {
    const base = new URL(baseUrl);
    const resolved = new URL(value, base);
    // `//host/x` and `/\host` parse as ANOTHER origin, so only a path that
    // lands on the base itself is kept.
    return resolved.origin === base.origin ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

/** Structural validity of a caller-supplied Ref: known kind, every field a
 *  non-empty string. Existence of the target is deliberately NOT checked
 *  (same stance as createTask's `links`): a dangling annotation is visible
 *  and harmless, where a dangling `after` edge would silently never block.
 *  `url` is the one kind with a value constraint beyond non-emptiness — not
 *  because we check that it resolves (we don't, same stance) but because it
 *  is the only kind that reaches the DOM as an href. */
export function isValidRef(ref: unknown): ref is Ref {
  if (typeof ref !== 'object' || ref === null) return false;
  const r = ref as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  switch (r.kind) {
    case 'doc':
      return str(r.docId);
    case 'thread':
      return str(r.docId) && str(r.threadId);
    case 'task':
      return str(r.taskId);
    case 'diff':
      return str(r.workspaceId);
    case 'url':
      return str(r.url) && isSafeHttpUrl(r.url);
    default:
      return false;
  }
}

/** Canonical identity of a Ref — two refs are the same link iff their keys
 *  match. Field order can't leak in (each kind lists its fields explicitly). */
export function refKey(ref: Ref): string {
  switch (ref.kind) {
    case 'doc':
      return `doc|${ref.docId}`;
    case 'thread':
      return `thread|${ref.docId}|${ref.threadId}`;
    case 'task':
      return `task|${ref.taskId}`;
    case 'diff':
      return `diff|${ref.workspaceId}`;
    case 'url':
      // Identity IS the URL string — that is what makes "which tasks point at
      // this pull request" answerable. No normalisation (no case folding, no
      // trailing-slash trimming): two spellings of the same page staying
      // distinct is a missed grouping, whereas collapsing two genuinely
      // different URLs would merge unrelated work.
      return `url|${ref.url}`;
  }
}

/**
 * The status a create lands on: `triage` when an AGENT filed it, `todo` when
 * a person did.
 *
 * `classifyActor` is the same line the transition trail and `assigneeKind`
 * already draw, reused rather than reinvented — a second predicate for
 * person-or-agent is a second thing that can disagree with the first.
 *
 * The one place this deliberately departs from it is the ABSENT actor.
 * `classifyActor` resolves "declares nothing" to `agent`, and that direction
 * is right where it lives (it keeps a person out of a strip built to stay
 * short). Here the same direction would take a row OUT of every dispatch read
 * on the strength of an absence — work silently missing, with nothing
 * anywhere saying so. Every creation ROUTE resolves an author before it gets
 * here (task-owner.ts), so the only caller this covers is a direct in-process
 * create that named nobody, and leaving that visible is the safe half.
 *
 * A GOAL row never comes through here — `syncGoalRows` mints those, and it
 * decides their status on a different rule (who is adding versus migrating,
 * not person versus agent). A new goal does start in `triage`, but that is
 * that method's answer, not this one's.
 */
export function initialTaskStatus(
  actor: { id: string; name: string; kind?: string } | undefined,
): TaskStatus {
  return actor !== undefined && classifyActor(actor) === 'agent' ? 'triage' : 'todo';
}

/**
 * Whether a row is a goal. The ONE place the discriminator is read, so an
 * absent `kind` resolves to "task" in exactly one spot rather than at every
 * call site — see the field's note on Task.
 */
export function isGoalRow(row: { kind?: 'task' | 'goal' }): row is GoalRow & { kind: 'goal' } {
  return row.kind === 'goal';
}

/** Proof as it arrives on the wire → what is stored, or nothing. A proof
 *  entry with no readable `text` is dropped rather than refused: the verdict
 *  is the claim, and a malformed attachment must not lose it. `unresolved` is
 *  a board path that no base url could make absolute. */
export function readDoneWhenProof(
  raw: unknown,
  baseUrl: string | undefined,
): { proof?: DoneWhenProof[]; unresolved?: string } {
  if (!Array.isArray(raw)) return {};
  const out: DoneWhenProof[] = [];
  for (const entry of raw) {
    const source = typeof entry === 'string' ? { text: entry } : (entry as DoneWhenProof | null);
    const text = typeof source?.text === 'string' ? source.text.trim() : '';
    if (text === '') continue;
    // The url becomes an href on the panel, so only http(s) is kept — the
    // same guard a task's `url` ref passes, for the same reason. An unsafe
    // scheme drops the LINK, not the proof: what the builder says it ran is
    // still worth reading. A board path is made absolute (`resolveProofUrl`).
    const given = typeof source?.url === 'string' ? source.url : '';
    const url = given !== '' ? resolveProofUrl(given, baseUrl) : undefined;
    if (url === 'needs-base') return { unresolved: given };
    // `refused` is the reporter's word that the check was denied on this
    // machine — stored only when it is literally `true`, so a caller sending
    // a string or a stray object cannot mark a line terminal by accident.
    const refused = source?.refused === true;
    out.push({ text, ...(url !== undefined ? { url } : {}), ...(refused ? { refused } : {}) });
  }
  return out.length > 0 ? { proof: out } : {};
}
