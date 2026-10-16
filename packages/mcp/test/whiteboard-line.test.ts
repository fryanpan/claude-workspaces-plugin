/**
 * What an agent reads when a person finishes a change to a whiteboard.
 */
import { describe, expect, it } from 'vitest';
import { whiteboardChangedLine } from '../src/whiteboard-line.ts';

describe('whiteboardChangedLine', () => {
  it('names who drew, each shape in the verb form, removals and the count', () => {
    const line = whiteboardChangedLine({
      docId: 'd1',
      docTitle: 'Harbour flow',
      actor: { name: 'Riverbend' },
      shapes: [
        { id: 'dock', kind: 'box', x: 0, y: 200, w: 160, h: 80, text: 'Dock' },
        { id: 'r', kind: 'arrow', x: 164, y: 240, w: 232, h: 0, from: 'dock', to: 'quay' },
      ],
      removed: ['old'],
      count: 3,
    });
    expect(line).toBe(
      '[whiteboard] Riverbend drew or changed box dock "Dock" at (0, 200) 160x80; arrow r at (164, 240) 232x0 dock→quay; removed old on "Harbour flow". The board holds 3 element(s). get_whiteboard reads it all.',
    );
  });

  it('caps a long burst at eight shapes and says how many more', () => {
    const shapes = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, kind: 'freedraw' }));
    const line = whiteboardChangedLine({ docId: 'd1', actor: { name: 'Saltmarsh' }, shapes });
    expect(line).toContain('freedraw s7; and 3 more');
    expect(line).not.toContain('s8');
  });
});
