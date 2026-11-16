/**
 * The colour each participant wears in the presence strip
 * (`presence-colours.ts`): far apart for different people, the same for one
 * participant on every page.
 */
import { PERSON_SPOT_FIELD } from '@claude-workspaces/core/workspace-presence';
import { describe, expect, it } from 'vitest';
import {
  PRESENCE_PALETTE,
  assignColours,
  paletteSlot,
  roomColours,
} from '../src/presence/presence-colours.ts';

/** The largest per-channel gap between two `#rrggbb` colours. */
function gap(a: string, b: string): number {
  const ch = (c: string, i: number) => Number.parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  return Math.max(...[0, 1, 2].map((i) => Math.abs(ch(a, i) - ch(b, i))));
}

describe('the presence palette', () => {
  it('holds colours far enough apart to tell at a glance', () => {
    for (const [i, a] of PRESENCE_PALETTE.entries()) {
      for (const b of PRESENCE_PALETTE.slice(i + 1))
        expect(gap(a, b), `${a} ${b}`).toBeGreaterThanOrEqual(45);
    }
  });
});

describe('assignColours', () => {
  it('gives every participant a different colour while the palette lasts', () => {
    const people = ['p-alice', 'p-bob', 'p-saltmarsh', 'p-riverbend'];
    const agents = ['a-agent-house-lead', 'a-ci-flakes', 'a-riverbend-builder'];
    const colours = assignColours(people, agents);
    expect(new Set(colours.values()).size).toBe(people.length + agents.length);
  });

  it('gives two keys that hash to one slot two colours', () => {
    // Find two keys that want the same slot, so the probe is exercised.
    const want = paletteSlot('p-alice');
    let other = '';
    for (let i = 0; !other; i++) if (paletteSlot(`p-x${i}`) === want) other = `p-x${i}`;
    const colours = assignColours(['p-alice', other], []);
    expect(colours.get('p-alice')).not.toBe(colours.get(other));
  });

  it('does not depend on the order the keys arrive in', () => {
    const a = assignColours(['p-bob', 'p-alice'], ['a-z', 'a-y']);
    const b = assignColours(['p-alice', 'p-bob'], ['a-y', 'a-z']);
    expect([...a].sort()).toEqual([...b].sort());
  });

  it('keeps a colour for everybody past the palette, sharing slots', () => {
    const many = Array.from({ length: PRESENCE_PALETTE.length + 3 }, (_, i) => `p-${i}`);
    const colours = assignColours(many, []);
    expect(colours.size).toBe(many.length);
    expect(new Set(colours.values()).size).toBe(PRESENCE_PALETTE.length);
  });
});

describe('roomColours', () => {
  const room = new Map<number, unknown>([
    [1, { user: { id: 'me', name: 'Alice' }, [PERSON_SPOT_FIELD]: { surface: 'board' } }],
    [2, { user: { id: 'bob', name: 'Bob' }, [PERSON_SPOT_FIELD]: { surface: 'doc', docId: 'q' } }],
  ]);

  it('colours a person the same on a page that knows more agents', () => {
    // The board knows every listening agent; a doc only those that pointed.
    const board = roomColours(room, 1, ['p-bob', 'a-agent-house-lead', 'a-ci-flakes']);
    const doc = roomColours(room, 2, ['p-me']);
    expect(doc.get('p-bob')).toBe(board.get('p-bob'));
    expect(doc.get('p-me')).toBe(board.get('p-me'));
    // CONTROL: the two people differ.
    expect(board.get('p-bob')).not.toBe(board.get('p-me'));
  });
});
