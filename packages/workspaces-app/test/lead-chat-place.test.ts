/**
 * The bar stops short of the comment widget's corner buttons, which load after
 * it. Driven through `createPlacer` with the boxes a 1180x820 board measures
 * (read off a real run of `lead-chat-heard-browser-driver.ts`): the agent
 * button ends at 74, and once the widget and its mic are in, the thread list
 * chip beside the comment button starts at 1060.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDock } from '../src/lead-chat/lead-chat-dock.ts';
import {
  CORNER_ROOM,
  type LeadChatPlacer,
  createPlacer,
} from '../src/lead-chat/lead-chat-place.ts';

const VW = 1180;
const VH = 820;

const at = (el: Element, left: number, top: number, width: number, height: number): void => {
  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    }) as DOMRect;
};

let placer: LeadChatPlacer | null = null;
const cleanups: Array<() => void> = [];

function placeBar(): HTMLElement {
  for (const [key, value] of [
    ['innerWidth', VW],
    ['innerHeight', VH],
  ] as const) {
    const was = Object.getOwnPropertyDescriptor(window, key);
    Object.defineProperty(window, key, { configurable: true, value });
    cleanups.push(() =>
      was
        ? Object.defineProperty(window, key, was)
        : delete (window as unknown as Record<string, unknown>)[key],
    );
  }
  const button = document.createElement('button');
  at(button, 30, 748, 44, 44);
  const bar = document.createElement('button');
  const pane = document.createElement('section');
  pane.hidden = true;
  const list = document.createElement('div');
  document.body.append(button, bar, pane);
  cleanups.push(() => {
    button.remove();
    bar.remove();
    pane.remove();
  });
  const dock = createDock({
    doc: document,
    grip: document.createElement('div'),
    storage: null,
    onResize: () => {},
  });
  placer = createPlacer({
    doc: document,
    win: window,
    placement: 'dock',
    button,
    bar,
    pane,
    list,
    dock,
  });
  placer.place();
  return bar;
}

/** A widget on the page, drawn as far as its comment button. */
function addWidget(): ShadowRoot {
  const widget = document.createElement('claude-feedback-widget');
  const root = widget.attachShadow({ mode: 'open' });
  const fab = document.createElement('button');
  fab.className = 'fab';
  at(fab, 1114, 754, 48, 48);
  root.append(fab);
  document.body.append(widget);
  cleanups.push(() => widget.remove());
  return root;
}

/** The mic arrives, and the thread list moves beside the comment button. */
function addSideChip(root: ShadowRoot): void {
  const chip = document.createElement('button');
  chip.className = 'fab-list side';
  at(chip, 1060, 756, 44, 44);
  root.prepend(chip);
}

const barRight = (bar: HTMLElement): number =>
  Number.parseFloat(bar.style.left) + Number.parseFloat(bar.style.width);

describe('the bar beside a widget that loads after it', () => {
  afterEach(() => {
    placer?.stop();
    placer = null;
    for (const undo of cleanups.splice(0).reverse()) undo();
  });

  it('keeps the default room while no widget is on the page', () => {
    const bar = placeBar();
    expect(barRight(bar)).toBe(VW - CORNER_ROOM + 12 - 8);
  });

  it('steps back from the widget the moment it arrives, without waiting for the chat to draw', async () => {
    const bar = placeBar();
    addWidget();
    await vi.waitFor(() => expect(barRight(bar)).toBe(1114 - 8));
  });

  it('steps back again when the mic moves the thread list beside the comment button', async () => {
    const bar = placeBar();
    const root = addWidget();
    await vi.waitFor(() => expect(barRight(bar)).toBe(1114 - 8));
    addSideChip(root);
    await vi.waitFor(() => expect(barRight(bar)).toBe(1060 - 8));
  });
});
