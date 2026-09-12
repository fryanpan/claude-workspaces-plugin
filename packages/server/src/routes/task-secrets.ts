import { matchRest } from '../middleware/workspace-scope.ts';
import { refuseOwnerOnlyWrite } from '../share/board-role.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/**
 * One route, and it is the only door on this server a secret value goes
 * through.
 *
 * It sits in a file of its own rather than with the rest of the review-item
 * family for two reasons. The family's file had crossed the 500-line bar, so
 * something had to move; and of everything in it, this is the block whose
 * prose a reader most needs uninterrupted, because the ORDER of its refusals
 * is the security property rather than a style. `routes/tasks.ts` calls it in
 * the position the block held, immediately before the rest of the family, so
 * nothing overtakes anything.
 */
export async function handleTaskSecrets(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, j, safeJson, secretWriter } = ctx;
  const { req, scope, authorFor, requireOwner } = rq;
  /**
   * The same reading of `review.ownerOnly` the rest of the family uses, and
   * deliberately a second call to the same function rather than a shared
   * helper passed between two route modules: `refuseOwnerOnlyWrite` IS the
   * one implementation, and the board comes off the SCOPE, so this fails
   * closed exactly where its twin does.
   */
  const workspaceId = scope?.workspaceId ?? '';
  const ownerOnlyDenial = (taskId: string, reviewItemId: string): Response | null =>
    refuseOwnerOnlyWrite(
      taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId)?.review,
      workspaceId,
      requireOwner,
    );

  /**
   * THE SECRETS DOOR — where a value the board's owner types reaches the
   * store, and the only place on this server it is ever held.
   *
   * It is a separate route from `/answer` rather than a flag on it because
   * the two carry different things. An answer is WORDS: recorded verbatim on
   * the item, echoed into the activity feed, read back by the agent that
   * asked. A value handed over here is the one thing that must reach none of
   * those. Sharing a door would mean one body field deciding whether the
   * payload is recorded or burned, and the failure mode of getting that wrong
   * is unrecoverable — a secret written into a `.ydoc` is a secret in a file
   * a person has to be told to go and destroy.
   *
   * WHAT THE ITEM GETS is `Secrets saved: <service>, <service>` — the names
   * the card already showed, through the ordinary `answerTaskReview`, so the
   * item closes, the queue drops it and the asking agent is woken exactly as
   * it would be by any other answer. The names are how it then reads a value
   * back; see `secretReadCommand`.
   *
   * THE ORDER OF THE REFUSALS IS THE SECURITY PROPERTY. The owner check runs
   * first, on the item as stored, before the body is even parsed — so a
   * Regular User's request is refused without this server having read what
   * they sent. `review.ownerOnly` is forced true for this shape by
   * `readReviewPayload`, on the write path and on every read, so there is no
   * secret item the flag can be missing from.
   */
  const taskSecretsMatch = matchRest(scope, /^tasks\/([^/]+)\/review-items\/([^/]+)\/secrets$/);
  if (taskSecretsMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskSecretsMatch[1] ?? '');
    const reviewItemId = decodeURIComponent(taskSecretsMatch[2] ?? '');
    {
      const denied = ownerOnlyDenial(taskId, reviewItemId);
      if (denied) return denied;
    }
    const item = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
    if (!item) return j(404, { error: 'not-found' });
    // Belt AND braces, and the braces are not decoration: the denial above
    // reads `ownerOnly`, which this shape forces — but an item that is NOT a
    // secret ask has no declared services, so a body naming any name at all
    // would be a caller choosing where a value is stored. Refusing by shape
    // is what makes the declared list the only reachable set of names.
    const declared = item.review.shape === 'secret' ? (item.review.secrets ?? []) : null;
    if (!declared || declared.length === 0) {
      return j(400, {
        error: 'not-a-secret-item',
        message: 'this item does not ask for any secrets; answer it with text instead',
      });
    }
    // The seam. Omitted, no command runs and nothing is half-done — see
    // `TaskRoutesContext.secretWriter`.
    if (!secretWriter) {
      return j(503, {
        error: 'secrets-unavailable',
        message: 'this server is not configured to store secrets',
      });
    }
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });

    // ALL OR NOTHING, by SERVICE NAME the item itself declared. A caller
    // cannot introduce a name: an entry naming anything the card did not show
    // is refused rather than stored, which is what keeps "where did this go?"
    // answerable from the item alone. And a partial hand-over is refused
    // rather than half-applied, because an item recorded as answered with one
    // of its two values missing tells the agent it may proceed.
    const sent = new Map<string, string>();
    const raw = body?.secrets;
    if (!Array.isArray(raw)) {
      return j(400, { error: 'secrets must be an array of { service, value }' });
    }
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return j(400, { error: 'each entry in secrets must be an object' });
      }
      const { service, value } = entry as { service?: unknown; value?: unknown };
      if (typeof service !== 'string' || !declared.some((d) => d.service === service)) {
        // The name is NOT echoed back. A refusal naming what the caller sent
        // is a refusal that has put caller-controlled text in a response, and
        // the reader already knows which names the card showed.
        return j(400, {
          error: 'unknown-secret',
          message: 'every entry must name one of the services this item asks for',
        });
      }
      if (typeof value !== 'string' || value === '') {
        return j(400, { error: 'each entry needs a non-empty string value' });
      }
      if (sent.has(service)) return j(400, { error: 'one entry per service' });
      sent.set(service, value);
    }
    const missing = declared.filter((d) => !sent.has(d.service));
    if (missing.length > 0) {
      return j(400, {
        error: 'incomplete',
        message: 'fill in every field — the ask is answered once, with all of its values',
      });
    }

    for (const field of declared) {
      // `??` cannot fire: every declared service is in the map by the check
      // above. It is here because the compiler cannot see that, and an empty
      // string would be refused by the writer rather than stored.
      const wrote = await secretWriter(field.service, sent.get(field.service) ?? '');
      if (!wrote.ok) {
        // The tag names the STEP, never the value — see `secret-store.ts`.
        // The item stays open: a retry rewrites whatever did land, because
        // the writer updates in place rather than refusing an existing name.
        return j(502, {
          error: 'store-failed',
          reason: wrote.error,
          message: 'the secret could not be stored; nothing was recorded on the item',
        });
      }
    }

    // Service names only. This string is the item's answer, the activity
    // line, and what the asking agent reads — which is why it is built from
    // the declared names rather than from anything the caller sent.
    const text = `Secrets saved: ${declared.map((d) => d.service).join(', ')}`;
    const res = taskStore.answerTaskReview(taskId, reviewItemId, text, { actor: author });
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    taskProjection.ensureWorkspace(res.task.workspaceId);
    return j(200, { taskId, reviewItemId, item: res.item, saved: declared.map((d) => d.service) });
  }
  return undefined;
}
