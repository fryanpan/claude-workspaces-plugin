/**
 * The two requests the owner's own hostname still takes while the master
 * sharing switch is off.
 *
 * Off refuses every outside hostname, the owner's included, and the only way
 * back is the owner approving the sharing notice's card (`sharing-notice.ts`).
 * Before this, that left an owner away from this machine and the tailnet with
 * no way to turn sharing back on, and the card had to take a loopback
 * caller's word that it was the owner. So `request-admission.ts` lets exactly
 * these through on the proxied operator hostname, and only after the Access
 * token verifies and names an allowlisted email:
 *
 *   GET  /sharing-off                                   the notice's page
 *   POST /workspaces/<ws>/tasks/<t>/review-items/<i>/access
 *                                                       its card's access door
 *
 * The door path is the OPEN card's alone, so no other card, board or route is
 * reachable while the switch is off. The door then asks its own person proof
 * from this server's own page (`routes/task-access.ts`).
 */

export const SHARING_OFF_PAGE_PATH = '/sharing-off';

/** The notice's open card, as `SharingNotice.openCard` names it. */
export interface SharingOffCard {
  workspaceId: string;
  taskId: string;
  itemId: string;
}

/** The access door's path for this card. */
export function sharingOffCardPath(card: SharingOffCard): string {
  const e = encodeURIComponent;
  return `/workspaces/${e(card.workspaceId)}/tasks/${e(card.taskId)}/review-items/${e(card.itemId)}/access`;
}

/** Is this one of the two requests the switch lets through while it is off? */
export function sharingOffDoorAllows(
  method: string,
  pathname: string,
  card: SharingOffCard | undefined,
): boolean {
  if (method === 'GET' && pathname === SHARING_OFF_PAGE_PATH) return true;
  return method === 'POST' && card !== undefined && pathname === sharingOffCardPath(card);
}
