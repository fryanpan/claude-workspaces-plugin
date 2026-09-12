/**
 * Declaring what a task is waiting on when the board cannot see the thing.
 *
 * ── The gap ─────────────────────────────────────────────────────────────
 *
 * The stall wake gets louder on purpose, and `stall-nudge.ts`'s `clockRows`
 * takes three kinds of row out of that clock: a ticket carrying a held review
 * item, one carrying a question a reader asked back, and one whose ask is
 * filed and pending on somebody's Home queue. Each is a wait the BOARD can
 * see, so the board can say when it ends.
 *
 * Plenty of real waits are not any of those. A row waiting for a peer to
 * restart the fleet, for a queue elsewhere to drain, for a person to land a PR
 * in another repo — nothing is held, nobody was asked, no item is pending. The
 * row reads as a plain stall and is re-said every repeat window to a lead who
 * can do nothing about it either time. Measured before this module: seven
 * frames over six windows, every one of them `escalated: true`.
 *
 * ── Why this is not a mute button ───────────────────────────────────────
 *
 * A lead that can assert "waiting on something" and be believed forever has
 * defeated the check, and the check exists because leads let work go dark. So
 * a declaration is not an assertion of state — it is a BOUNDED deferral, and
 * four things end it:
 *
 *  1. **It expires.** Every declaration carries `until`, at most
 *     `EXTERNAL_WAIT_MAX_MS` away. Past it the row is back on the clock
 *     carrying its whole accumulated silence, so the escalation the wait
 *     bought is deferred, never cancelled — and the frame names the lapse in
 *     the lead's own words, so it reads as "the wait you declared has run
 *     out" rather than as a row that mysteriously got loud again.
 *  2. **It is cleared**, by the declarer or anyone else holding the row.
 *  3. **The wake's other explanations still apply.** A hold or an asked-back
 *     question arriving on the same row is its own finding and is named as
 *     one; nothing here suppresses them.
 *  4. **It never excuses an UNFILED ask.** A row reading
 *     `blocked-on-owner-unfiled` is waiting on a PERSON with the question
 *     filed nowhere they read, and the remedy — file it — is the lead's and
 *     available now. `stall-gate.ts` applies the wait to stalled rows only,
 *     for that reason.
 *
 * And it is visible the whole time: `since` survives a renewal that does not
 * change the words, so a wait renewed all day reads as nine hours on the
 * frame rather than as a fresh one.
 *
 * ── What is NOT here ────────────────────────────────────────────────────
 *
 * Dispatch. A declared wait changes what the wake SAYS and nothing else — the
 * row keeps its status, keeps its queue position, and keeps being judged for
 * every other finding. `block_task` is the verb for "do not start this yet",
 * and it means something the board can verify; folding the two together would
 * let an unverifiable sentence take a row out of the queue.
 */
import type { ExternalWait, Task } from '@claude-workspaces/core/task-wire';

/**
 * How long a declaration stands when the caller names no duration.
 *
 * One hour. The stall wake's repeat window is thirty minutes, so a wait
 * shorter than one window buys nothing at all, and two windows is the
 * smallest declaration that actually quiets anything. A caller who knows how
 * long the thing takes should say so; this is the number for one who does
 * not.
 */
export const EXTERNAL_WAIT_DEFAULT_MS = 60 * 60_000;

/**
 * The ceiling on one declaration. Eight hours.
 *
 * The number is a judgement and the reasoning is what matters: a wait that
 * outlives a working session is not a wait, it is a decision to stop working
 * the row — and the board already spells that, with `block_task` when another
 * task is the blocker and a status move when nothing is. Capping here is what
 * keeps "the board cannot see it" from becoming "the board cannot check it
 * either, indefinitely": the longest silence a single declaration can buy is
 * bounded, and buying more means declaring again, which leaves `since`
 * standing and says so on the frame.
 */
export const EXTERNAL_WAIT_MAX_MS = 8 * 60 * 60_000;

/** The longest `what` accepted. It rides a wake line a person skims; past
 *  this it is a paragraph pretending to be a subject. */
export const EXTERNAL_WAIT_WHAT_MAX = 200;

/** The slice of the task store this module writes through — the same two
 *  members `setTaskSchedule` takes, and for the same reason: the sidecar
 *  round-trips whole task objects, so a field write plus a save is the whole
 *  of persistence. */
export interface ExternalWaitStore {
  getTask(taskId: string): Task | undefined;
  scheduleSave(workspaceId: string): void;
}

export type SetExternalWaitResult =
  | { ok: true; task: Task; wait: ExternalWait }
  | { ok: false; error: 'not-found' | 'what-required' | 'what-too-long' | 'bad-duration' };

export type ClearExternalWaitResult =
  | { ok: true; task: Task; changed: boolean }
  | { ok: false; error: 'not-found' };

/**
 * Is this declaration still standing at `now`?
 *
 * The one reader of `until`, so "lapsed" cannot come to mean two things in
 * two files. A wait with no `until` — which no writer here produces, but a
 * hand-edited sidecar could — reads as lapsed rather than as eternal: the
 * failure direction of an unreadable declaration must be that the row keeps
 * being checked.
 */
export function externalWaitActive(wait: ExternalWait | undefined, now: number): boolean {
  if (!wait) return false;
  if (typeof wait.until !== 'number' || !Number.isFinite(wait.until)) return false;
  return wait.until > now;
}

/**
 * Declare, or renew, what a row is waiting on.
 *
 * `since` is the one piece of state that survives: a renewal whose words are
 * unchanged keeps the moment the wait STARTED, because that is the number a
 * reader needs to see that a wait has been rolling over all day. Changing the
 * words makes it a different wait and restarts the count — it is a different
 * thing being waited for, and carrying the old start would overstate it.
 */
export function setExternalWait(
  store: ExternalWaitStore,
  taskId: string,
  input: { what: string; by: string; now: number; durationMs?: number },
): SetExternalWaitResult {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'not-found' };
  const what = typeof input.what === 'string' ? input.what.trim() : '';
  if (what === '') return { ok: false, error: 'what-required' };
  if (what.length > EXTERNAL_WAIT_WHAT_MAX) return { ok: false, error: 'what-too-long' };
  const requested = input.durationMs ?? EXTERNAL_WAIT_DEFAULT_MS;
  // Refused rather than clamped. A caller asking for a week has misunderstood
  // what this verb is, and silently giving them eight hours would leave them
  // believing the row is quiet for six more days.
  if (!Number.isFinite(requested) || requested <= 0 || requested > EXTERNAL_WAIT_MAX_MS)
    return { ok: false, error: 'bad-duration' };
  const prior = task.externalWait;
  const wait: ExternalWait = {
    what,
    since: prior !== undefined && prior.what === what ? prior.since : input.now,
    declaredAt: input.now,
    until: input.now + requested,
    by: input.by,
  };
  task.externalWait = wait;
  task.updatedAt = input.now;
  store.scheduleSave(task.workspaceId);
  return { ok: true, task, wait };
}

/**
 * End a declared wait now. `changed: false` when there was none — a caller
 * clearing twice has not failed at anything, and a 404 here would send them
 * hunting for a task that is fine.
 */
export function clearExternalWait(
  store: ExternalWaitStore,
  taskId: string,
  now: number,
): ClearExternalWaitResult {
  const task = store.getTask(taskId);
  if (!task) return { ok: false, error: 'not-found' };
  if (task.externalWait === undefined) return { ok: true, task, changed: false };
  task.externalWait = undefined;
  task.updatedAt = now;
  store.scheduleSave(task.workspaceId);
  return { ok: true, task, changed: true };
}
