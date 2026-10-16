import type { SceneElement } from '@claude-workspaces/core/whiteboard-scene';
/**
 * The Excalidraw canvas, mounted with real React into one element.
 *
 * The rest of the app renders with Preact; Excalidraw needs React itself, so
 * this module is the one place React is imported, and it is reached only
 * through the page's dynamic `import()`, which puts React and Excalidraw in
 * their own chunk. No JSX here: the repo's JSX compiles to Preact.
 *
 * Excalidraw's own typings reach into packages it does not ship, so the few
 * calls made here are typed by the small interfaces below rather than by
 * its declarations.
 */
import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { GestureState, RemoteCursor } from './scene-sync.ts';

/** What the page asks of the canvas once it is up. */
export interface CanvasHandle {
  /** Every element the canvas holds, deleted ones included. */
  elements(): readonly unknown[];
  /** The canvas state, read for the gesture fields. */
  gesture(): GestureState;
  /** Replace what the canvas shows, without an undo step. */
  show(elements: readonly SceneElement[]): void;
  /** Draw the other people's and agents' pointers. */
  cursors(list: readonly RemoteCursor[]): void;
}

export interface CanvasOptions {
  initial: readonly SceneElement[];
  /** Every change the canvas reports, finished or not. */
  onChange: () => void;
  /** The person's pointer moved, in canvas units. */
  onPointer: (p: { x: number; y: number }) => void;
}

interface ExcalidrawApi {
  getSceneElementsIncludingDeleted(): readonly unknown[];
  getAppState(): GestureState;
  updateScene(scene: {
    elements?: readonly unknown[];
    collaborators?: Map<string, unknown>;
    captureUpdate?: unknown;
  }): void;
}

const ExcalidrawComponent = Excalidraw as unknown as React.ComponentType<Record<string, unknown>>;

export function mountCanvas(host: HTMLElement, opts: CanvasOptions): Promise<CanvasHandle> {
  return new Promise((resolve) => {
    let api: ExcalidrawApi | null = null;
    const props: Record<string, unknown> = {
      initialData: {
        elements: opts.initial,
        appState: { viewBackgroundColor: '#ffffff', currentItemFontFamily: 5 },
        scrollToContent: opts.initial.length > 0,
      },
      isCollaborating: true,
      excalidrawAPI: (a: ExcalidrawApi) => {
        if (api) return;
        api = a;
        const ready = a;
        resolve({
          elements: () => ready.getSceneElementsIncludingDeleted(),
          gesture: () => ready.getAppState(),
          show: (elements) =>
            ready.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER }),
          cursors: (list) => {
            const collaborators = new Map<string, unknown>();
            for (const c of list) {
              collaborators.set(c.key, {
                username: c.name,
                color: { background: c.color, stroke: c.color },
                pointer: { x: c.x, y: c.y, tool: 'pointer' },
                isCurrentUser: false,
              });
            }
            ready.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
          },
        });
      },
      onChange: () => opts.onChange(),
      onPointerUpdate: (p: { pointer: { x: number; y: number } }) => opts.onPointer(p.pointer),
      UIOptions: {
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          export: false,
          saveAsImage: false,
          toggleTheme: false,
        },
      },
    };
    createRoot(host).render(React.createElement(ExcalidrawComponent, props));
  });
}
