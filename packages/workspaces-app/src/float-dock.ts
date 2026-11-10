/**
 * The one row of floating controls at the bottom of the editor pane.
 *
 * It holds the plan gate's Approve float (plan-gate.ts). It held a second,
 * Review, until 2026-11-09, which is why it is a row: the stylesheet places
 * the ROW rather than any one button, and whichever float mounts first
 * creates it.
 */
export function floatDock(anchor: Element): HTMLElement {
  for (const child of Array.from(anchor.children)) {
    if (child instanceof HTMLElement && child.classList.contains('doc-floats')) return child;
  }
  const dock = document.createElement('div');
  dock.className = 'doc-floats';
  anchor.append(dock);
  return dock;
}
