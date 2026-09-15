import { useEffect, useRef } from 'preact/hooks';
import { type ReviewItemSeenTarget, reviewItemSeen } from '../review-item-seen.ts';

/**
 * Watch this card for `review_item.viewed` — the preact side of
 * `review-item-seen.ts`, which owns the rule about what "shown" means.
 *
 * Returns the ref to spread onto the card's outermost element. The effect
 * re-runs when the card starts showing a DIFFERENT item, which is the case
 * that matters: the walkthrough keys its card on `ReviewItem.key` and so
 * REUSES the same DOM as the reader answers their way down the queue — a
 * watch bound once at mount would measure the first item and none of the ones
 * that replaced it in the same box.
 *
 * `null` for a row with no item id (an inferred unreplied ask) watches
 * nothing, which is the honest answer rather than a made-up id.
 */
export function useReviewItemSeen(target: ReviewItemSeenTarget | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const workspaceId = target?.workspaceId ?? '';
  const reviewItemId = target?.reviewItemId ?? '';
  const taskId = target?.taskId ?? '';
  useEffect(() => {
    const el = ref.current;
    if (!el || reviewItemId === '' || workspaceId === '') return;
    reviewItemSeen().watch(el, {
      workspaceId,
      reviewItemId,
      ...(taskId ? { taskId } : {}),
    });
  }, [workspaceId, reviewItemId, taskId]);
  return ref;
}
