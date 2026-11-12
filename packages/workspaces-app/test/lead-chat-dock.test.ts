/**
 * How wide the docked chat may go on a page that needs more of the screen than
 * most. Driven through `createDock`, which the panel asks for its width.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ROOM_CHANGE_EVENT } from '../src/card-placement.ts';
import { DOCK_W, createDock } from '../src/lead-chat/lead-chat-dock.ts';

const dockWidth = (screen: number): number =>
  createDock({
    doc: document,
    grip: document.createElement('div'),
    storage: null,
    onResize: () => {},
  }).width(screen);

describe('the docked chat beside a page that says how much it needs', () => {
  afterEach(() => {
    delete document.body.dataset.lcPageMin;
  });

  it('keeps its usual width on a page that says nothing', () => {
    expect(dockWidth(1180)).toBe(DOCK_W);
  });

  it('gives way to what the page asks for', () => {
    document.body.dataset.lcPageMin = '788';
    expect(dockWidth(1180)).toBe(392);
  });

  it('never goes narrower than a chat can be read in', () => {
    document.body.dataset.lcPageMin = '788';
    expect(dockWidth(1104)).toBe(320);
  });
});

describe('a doc page told when the docked chat changes its room', () => {
  it('fires the room change when the panel docks, resizes and undocks, and not when nothing changed', () => {
    const dock = createDock({
      doc: document,
      grip: document.createElement('div'),
      storage: null,
      onResize: () => {},
    });
    let fired = 0;
    const count = (): void => {
      fired++;
    };
    window.addEventListener(ROOM_CHANGE_EVENT, count);
    try {
      dock.docked(420);
      dock.docked(420);
      expect(fired).toBe(1);
      dock.docked(500);
      expect(fired).toBe(2);
      dock.docked(null);
      dock.docked(null);
      expect(fired).toBe(3);
      expect(document.documentElement.dataset.lcDocked).toBeUndefined();
    } finally {
      window.removeEventListener(ROOM_CHANGE_EVENT, count);
    }
  });
});
