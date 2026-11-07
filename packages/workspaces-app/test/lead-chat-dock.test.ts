/**
 * How wide the docked chat may go on a page that needs more of the screen than
 * most. Driven through `createDock`, which the panel asks for its width.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
