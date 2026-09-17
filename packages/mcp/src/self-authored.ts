/**
 * Never deliver an event back to the session that caused it.
 *
 * THE DEFECT. A session acts on the board — it posts a comment, files a
 * review item, attaches — the server fires the event, and the fan-out reaches
 * every stream on the doc's channel and on every board channel holding it,
 * INCLUDING the acting session's own. The MCP child then rendered it into
 * that session as a `<channel source="claude-workspaces" …>` block. The wake
 * carries zero information — the session did the thing — and it costs a turn
 * plus the payload, so a long review comment is thousands of tokens
 * re-injected into the context that produced it. Measured 2026-08-24 on
 * comments by four sessions; measured again 2026-09-17 across the fleet's
 * week at 6.3–10.2% of its wakes once review items and attaches are counted.
 *
 * ONE RULE, ONE MODULE. This file used to hold only the comment half, with
 * the board half spelled inline in `channel-messages.ts` as
 * `p.actor?.id === deps.authorId`. Two homes meant two coverages: the inline
 * check ran only for the five board prefixes its regex named, so
 * `review_item.added` / `.revised` / `.withdrawn` — which carry a perfectly
 * good `actor` — took the doc path and were never tested against it, and
 * `agent.attached` / `.detached` matched the board path but name their actor
 * as `agentId` rather than `actor`, so the check could not see it. Every
 * renderer now asks THIS function, and every attribution rule is in the table
 * below.
 *
 * WHY HERE AND NOT IN THE SERVER. Four reasons, in order of weight:
 *
 *  1. The same frame rides several transports — the doc's own channel, each
 *     board's `ws~<id>` channel, and the REPLAY buffer a reconnecting stream
 *     drains. One gate at the render point covers all of them; a per-sink
 *     filter in `SseBus.broadcast` would cover the live sends and leak the
 *     replay straight back, because a broadcast frame is buffered once with
 *     no addressee and replayed to everyone.
 *  2. A frame the server withheld is a frame the child cannot ACK. The
 *     comment queue and the voice queue are both receipt-driven
 *     (`frame-handler.ts`, `channel-messages.ts`): a row stays durable until
 *     the child posts back that it holds the frame. Dropping the frame on the
 *     wire would strand those rows and have the server re-offer them after
 *     every grace window, forever. Dropping it HERE removes the wake and
 *     leaves both receipts on their existing path — `handleFrame` acks
 *     outside this gate on purpose.
 *  3. `/events/<docId>` carries no `agentId`, and the multiplexed route
 *     registers one on BOARD channels only (`sse-mux.ts`), so a server-side
 *     gate could not see the actor's own doc stream without an MCP change
 *     here anyway.
 *  4. It narrows nothing on the shared server. Per CLAUDE.md the real
 *     compatibility hazard is a peer on an older bundle calling a route it
 *     cannot be restarted away from; a server-side suppression would change
 *     what those sessions RECEIVE, while this changes only what a bundle does
 *     with what it already received. Old bundles keep today's behaviour until
 *     they restart.
 *
 * WHAT IS NOT LOST. Suppressing the wake never hides the STATE: nothing here
 * touches the store, the `.ydoc` or any read path, so the item, the comment
 * and the roster row are all exactly where the next `get_doc`, `list_threads`,
 * `next_tasks` or `get_workspace` will find them. The only thing removed is
 * being told about it a second time.
 *
 * A browser is untouched by construction: it never runs this code, and a
 * reviewer must still watch their own comment appear.
 *
 * WHY IT FAILS OPEN — the whole design. A duplicated wake is a visible
 * annoyance. A dropped one is silence, and an agent cannot tell silence from
 * "nobody commented", which is the failure class watches exist to close. So
 * this answers `true` only when the actor is POSITIVELY identified and is
 * unambiguously this session; every gap — no attribution on the payload, no
 * id, a non-string id, an event with no rule, a shared identity — resolves to
 * delivering.
 *
 * WHAT IT CANNOT TELL APART. A session and its subagent both resolve to one
 * `agent-<slug>`, so the subagent's act is suppressed for the parent and the
 * parent's for the subagent. That is the same trade the board half has made
 * since it shipped, and it is the safe direction: the state is still there to
 * be read, and the alternative — matching on something narrower than the
 * identity every other MCP call carries — has nothing to match on.
 */

/**
 * Comment events. The actor is the person who spoke, and their authorship is
 * the only attribution that may suppress a comment body.
 */
const COMMENT_EVENTS = new Set(['thread.created', 'thread.replied']);

/**
 * Status changes on a thread. `doc-store.ts` stamps `actor` on these
 * precisely because there is no comment to read an author off — see the
 * `fireEvent` signature.
 */
const STATUS_EVENTS = new Set(['thread.resolved', 'thread.reopened']);

/**
 * The review-item MEASUREMENT rows, which name their actor as a bare
 * `actorId` string rather than a `TaskActor`. `tasks.ts` says why: the name
 * adds nothing to a subtraction and these rows are written far more often
 * than any other. Listed explicitly so the board rule below can stay a rule
 * about `actor`.
 */
const ACTOR_ID_EVENTS = new Set(['review_item.viewed', 'review_item.answered']);

/**
 * Board and ticket events: the actor is the top-level `actor`.
 *
 * A PREFIX rather than a list of event names, deliberately. A name list goes
 * stale the moment somebody adds an event, and the way it goes stale is that
 * the new event echoes — which is the defect this file exists to close, back
 * again under a new name. Every family here already carries `actor` on every
 * member that an agent can cause, and the ones a SERVER causes
 * (`workspace.ready_idle`, `workspace.stalled`, `workspace.review_item_held`,
 * `workspace.review_answered`, `workspace.done_when_ready`) carry no
 * top-level actor at all, so they fail open and keep waking their addressee.
 */
const ACTOR_FAMILY_RE = /^(task|decision|workspace|voice|review_item)\./;

/**
 * The attachment family, whose subject IS its actor: `agent.attached` and
 * `agent.detached` are caused by the agent they name, and name it as
 * `agentId`. (`agent.heartbeat` never reaches a renderer and
 * `agent.listening` never reaches an agent stream at all, but both read the
 * same way here and cost nothing.)
 */
const AGENT_FAMILY_RE = /^agent\./;

/**
 * An id that names a CATEGORY or a PERSON rather than this session.
 *
 * `CW_AGENT_NAME` unset resolves every anonymous session to `known-agent`;
 * a session launched as "Bryan" resolves to `known-bryan`, which is the very
 * id Bryan's browser comments carry. Suppressing on either would let one
 * session swallow a sibling's comments, or an agent swallow the human's.
 * `agent-<slug>` ids are synthesized per name and are the only ones that
 * identify a single session, so only those may suppress.
 *
 * Same rule `agent-watches.ts` applies to a shared watch set, for the same
 * reason: a category is not somebody.
 */
function identifiesOneSession(selfId: string): boolean {
  const id = selfId.trim();
  return id.length > 0 && !id.startsWith('known-');
}

function idOf(who: unknown): string | undefined {
  if (!who || typeof who !== 'object') return undefined;
  const id = (who as { id?: unknown }).id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * The actor this frame can be attributed to, or `undefined` when it cannot
 * be — which is a real outcome, not a defect, and the caller must deliver.
 *
 * `thread.created` fires with `comment: undefined` and the opening comment
 * inside the thread (doc-store.ts:829), so it reads the thread's newest comment —
 * the same fallback `queueCommentRows` in server.ts uses, deliberately spelled
 * to match rather than invented a second time.
 *
 * `thread.replied` gets NO such fallback. It also fires with no comment on the
 * undo-answer path (doc-store.ts:1023), where nothing was said and a stamp was
 * removed; the thread's newest comment is somebody's words, not the actor, and
 * reading it there would suppress on a stranger's identity.
 *
 * `suggestion.created` reads the SUGGESTION's author, because that is who
 * proposed it. Its two verdicts are deliberately absent: `suggestion.accepted`
 * and `suggestion.rejected` carry the SUGGESTER as author too, and the
 * accepting party is not on the frame at all — so matching on the author
 * would swallow exactly the outcome the suggesting agent is waiting on.
 */
function frameActorId(event: string, payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const p = payload as {
    comment?: unknown;
    thread?: { comments?: unknown };
    actor?: unknown;
    actorId?: unknown;
    agentId?: unknown;
    suggestion?: unknown;
  };
  if (STATUS_EVENTS.has(event)) return idOf(p.actor);
  if (ACTOR_ID_EVENTS.has(event)) return stringOf(p.actorId);
  if (event === 'suggestion.created') return idOf((p.suggestion as { author?: unknown })?.author);
  if (AGENT_FAMILY_RE.test(event)) return stringOf(p.agentId);
  if (ACTOR_FAMILY_RE.test(event)) return idOf(p.actor);
  if (!COMMENT_EVENTS.has(event)) return undefined;
  const direct = idOf((p.comment as { author?: unknown } | undefined)?.author);
  if (direct) return direct;
  if (event !== 'thread.created') return undefined;
  const comments = p.thread?.comments;
  if (!Array.isArray(comments) || comments.length === 0) return undefined;
  return idOf((comments[comments.length - 1] as { author?: unknown } | undefined)?.author);
}

/**
 * Whether this frame is the session's own act coming back to it.
 *
 * `true` means "suppress"; anything uncertain answers `false`.
 */
export function isSelfAuthoredEvent(event: string, payload: unknown, selfId: string): boolean {
  if (!identifiesOneSession(selfId)) return false;
  const actor = frameActorId(event, payload);
  return actor !== undefined && actor.toLowerCase() === selfId.trim().toLowerCase();
}
