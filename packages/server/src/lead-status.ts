/**
 * The board's lead as the home feed reports it to Team Lead on another
 * machine (`HomeFeedLead`, `home-feed.ts`): who holds the seat, whether that
 * session can be reached now, and when it last sent a heartbeat and called a
 * tool. It is what lets Team Lead tell a lead that is working from one that
 * is up but stuck, or gone, without reading the board itself.
 *
 * Read from the attachment table only. No task text, no paths: the feed
 * crosses machines, and these are times and one id.
 */
import type { HomeFeedLead } from './home-feed.ts';

export interface LeadStatusSource {
  getWorkspace(id: string): { leadAgentId?: string } | undefined;
  hasLiveAttachmentFor(workspaceId: string, agentId: string): boolean;
  listAttachments(
    workspaceId: string,
  ): ReadonlyArray<{ agentId: string; lastHeartbeat: number; lastToolCallAt: number }>;
}

/** The lead's status, or undefined when the board names no lead. */
export function leadStatusOf(
  source: LeadStatusSource,
  workspaceId: string,
): HomeFeedLead | undefined {
  const agentId = source.getWorkspace(workspaceId)?.leadAgentId;
  if (agentId === undefined) return undefined;
  const att = source.listAttachments(workspaceId).find((a) => a.agentId === agentId);
  return {
    agentId,
    live: source.hasLiveAttachmentFor(workspaceId, agentId),
    ...(att ? { lastSeenAt: att.lastHeartbeat, lastToolCallAt: att.lastToolCallAt } : {}),
  };
}
