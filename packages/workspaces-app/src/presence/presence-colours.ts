/**
 * The colour each person and agent wears in the presence strip: its deck
 * circle, its row in the list, its card and the follow bar.
 *
 * A colour comes from a fixed palette, not from a hue hashed out of a name.
 * The hashed hue gave neighbours on the colour wheel to different people:
 * Bob and Saltmarsh came out at hues 5 and 13, two reds nobody can tell apart
 * at 20px, and Bryan saw "a bunch of bubbles ... almost all the same color"
 * (2026-11-15). Seven colours that are far apart, each dark enough to carry
 * white initials, are told apart at a glance.
 *
 * Seven colours cannot be given out by hash alone without two people sharing
 * one, so each participant takes its hashed slot or, if somebody already
 * holds it, the next free one. The order is fixed so that every page agrees:
 * every person in the room first (every page reads the same room, the reader
 * included), sorted by key; then the agents, sorted by key. A person
 * therefore wears the same colour on the board, on a doc and on every
 * viewer's screen. An agent's colour can differ between two pages only when
 * the pages know different agents and two of them want one slot.
 *
 * Keyed on the participant (`p-<identity>`, `a-<agentId>`), never the label:
 * an agent's label changes from its id to the name it points under, and its
 * colour must not change with it.
 */
import { presenceIdentity } from '../board/board-presence-model.ts';
import { type RoomStates, agentSpotsFromStates, peopleFromStates } from './follow-model.ts';

/** Far apart in hue, and each at least 4.5:1 against white initials. */
export const PRESENCE_PALETTE = [
  '#2563eb', // blue
  '#c2410c', // orange
  '#15803d', // green
  '#7c3aed', // violet
  '#0f766e', // teal
  '#c026d3', // fuchsia
  '#475569', // slate
] as const;

/** FNV-1a: a short key's slot, the same on every page. */
export function paletteSlot(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % PRESENCE_PALETTE.length;
}

/** The colour a participant wears when nobody else is counted. */
export function soloColour(key: string): string {
  return PRESENCE_PALETTE[paletteSlot(key)] ?? PRESENCE_PALETTE[0];
}

/**
 * A colour for each key. `people` and `agents` are taken in that order, each
 * sorted, each taking its hashed slot or the next free one. Once every slot
 * is held, a key wears its hashed slot and shares it.
 */
export function assignColours(
  people: Iterable<string>,
  agents: Iterable<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const held = new Set<number>();
  const n = PRESENCE_PALETTE.length;
  const take = (key: string): void => {
    if (out.has(key)) return;
    const first = paletteSlot(key);
    let slot = first;
    if (held.size < n) {
      while (held.has(slot)) slot = (slot + 1) % n;
    }
    held.add(slot);
    out.set(key, PRESENCE_PALETTE[slot] ?? PRESENCE_PALETTE[0]);
  };
  for (const key of [...new Set(people)].sort()) take(key);
  for (const key of [...new Set(agents)].sort()) take(key);
  return out;
}

/**
 * The colours for one page's chips: every person in the room, then every
 * agent the page knows of (its chips and the room's pointers).
 */
export function roomColours(
  states: RoomStates,
  selfClientId: number,
  chipKeys: Iterable<string>,
): Map<string, string> {
  const people = peopleFromStates(states, selfClientId).map((p) => `p-${presenceIdentity(p)}`);
  const agents = new Set([...agentSpotsFromStates(states).keys()].map((id) => `a-${id}`));
  const keys = [...chipKeys];
  for (const key of keys) {
    if (key.startsWith('a-')) agents.add(key);
  }
  // A person chip the room has not announced yet (a page painted before its
  // first awareness update) still gets a colour, after the room's own.
  const late = keys.filter((k) => k.startsWith('p-') && !people.includes(k));
  return assignColours([...people, ...late], agents);
}
