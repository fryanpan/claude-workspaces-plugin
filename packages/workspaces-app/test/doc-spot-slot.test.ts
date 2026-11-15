/**
 * The page's presence is its own chunk and starts listening after the doc on
 * screen can already scroll. A move made in that gap used to be dropped, so
 * the person's spot stayed at the top of the doc until they scrolled again.
 */
import { describe, expect, it } from 'vitest';
import { docSpotMoved, onDocSpotMove } from '../src/presence/doc-spot-slot.ts';

describe('the doc spot slot', () => {
  it('passes on a move made before presence listened, once, and later moves as they come', () => {
    docSpotMoved({ blockId: 'b-1', scroll: 0.1 }, 'Quay');
    docSpotMoved({ blockId: 'b-2', scroll: 0.3 }, 'Tides');
    const said: unknown[] = [];
    onDocSpotMove((spot, heading) => said.push([spot, heading]));
    expect(said).toEqual([[{ blockId: 'b-2', scroll: 0.3 }, 'Tides']]);

    docSpotMoved({ blockId: 'b-3', scroll: 0.6 }, 'Lights');
    const again: unknown[] = [];
    onDocSpotMove((spot, heading) => again.push([spot, heading]));
    expect(said).toHaveLength(2);
    expect(again).toEqual([]);
  });
});
