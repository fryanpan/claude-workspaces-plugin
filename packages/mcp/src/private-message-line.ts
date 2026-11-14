/**
 * The channel line for `private.message`: a person's private message to the
 * agent they linked as their lead agent (`routes/private-messages.ts` on the
 * server). Only that agent's own stream carries it. The line names the
 * person and gives the verb that answers them privately, because a reply on
 * a thread or in lead chat would be read by the whole board.
 *
 * Nothing for a message an agent wrote: the person's channel carries those,
 * and this agent never needs its own words back.
 */

export interface PrivateMessageLike {
  personId?: string;
  from?: string;
  author?: { id?: string; name?: string };
  text?: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function privateMessageLine(p: PrivateMessageLike, selfId: string): string | null {
  if (p.from !== 'person' || p.author?.id === selfId || !p.personId) return null;
  const who = p.author?.name || p.personId;
  return `[private] ${who} (your person): ${clip(p.text ?? '', 2000)} Answer with reply_private(personId="${p.personId}").`;
}
