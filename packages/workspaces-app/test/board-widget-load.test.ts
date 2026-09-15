/**
 * The board loads the comment widget itself, into its own bundle.
 *
 * The shell used to add `<script src="/widget.esm.js">`, the bundle built for
 * other people's pages, which carries its own Yjs — two copies on every board.
 * Now the shell renders only the element and `bootBoard` imports the widget,
 * so it shares the board's Yjs. `check:client-boot` proves the one-copy half
 * in a real browser; this pins the decision: load it when the shell asked, and
 * not otherwise — once the task list has synced, or at a deadline armed before
 * anything that could fail.
 *
 * Not before the sync: the launcher brings its own chunk, its own session read
 * and its own socket, and on a link a round trip away all three stood in front
 * of the board's payload.
 *
 * All fixtures synthetic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_WIDGET_DEADLINE_MS, bootBoard } from '../src/board/board-app.ts';
import {
  type FakeClient,
  fakeHistory,
  fakeLocation,
  fakeSockets,
  fakeStorage,
  installFakeBeacon,
  installFakeEventSource,
  installFakeServer,
  settle,
} from './boot-harness.ts';

const server = installFakeServer();
installFakeEventSource();
installFakeBeacon();

async function bootWith(bodyHtml: string, url: string): Promise<ReturnType<typeof vi.fn>> {
  document.body.innerHTML = bodyHtml;
  const loadWidget = vi.fn(async () => undefined);
  await bootBoard({
    document,
    location: fakeLocation(url),
    history: fakeHistory(),
    localStorage: fakeStorage({ 'feedback-user-name': 'Kiln' }),
    window: new EventTarget(),
    connect: fakeSockets().connect,
    loadWidget,
  });
  await settle();
  return loadWidget;
}

describe('the board and its comment widget', () => {
  it('loads the widget when the shell rendered one, even if the board then bails', async () => {
    // A path naming no workspace ends the boot before its first await. The
    // widget used to arrive as its own script, so the board failing to boot
    // never took the feedback launcher with it, and it still must not.
    const loadWidget = await bootWith(
      '<div id="board-root"></div><claude-feedback-widget doc-id="lf-hub-feedback"></claude-feedback-widget>',
      'https://board.test/',
    );
    expect(document.getElementById('board')).toBeNull();
    expect(loadWidget).toHaveBeenCalledTimes(1);
  });

  it('loads nothing when the shell rendered no widget, as for a share visitor', async () => {
    const loadWidget = await bootWith('<div id="board-root"></div>', 'https://board.test/');
    expect(loadWidget).not.toHaveBeenCalled();
  });

  describe('on a board that boots', () => {
    const WIDGET = '<div id="board-root"></div><claude-feedback-widget></claude-feedback-widget>';
    const BOARD_URL = 'https://board.test/workspaces/w-saltmarsh/tasks';

    function start(): { loadWidget: ReturnType<typeof vi.fn>; opened: FakeClient[] } {
      server.reset();
      server.on('/workspaces/w-saltmarsh', {
        workspace: { id: 'w-saltmarsh', name: 'Saltmarsh', goals: [] },
      });
      document.body.innerHTML = WIDGET;
      const loadWidget = vi.fn(async () => undefined);
      const sockets = fakeSockets();
      void bootBoard({
        document,
        location: fakeLocation(BOARD_URL),
        history: fakeHistory(),
        localStorage: fakeStorage({ 'feedback-user-name': 'Kiln' }),
        window: new EventTarget(),
        connect: sockets.connect,
        loadWidget,
      });
      return { loadWidget, opened: sockets.opened };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits for the task list to sync before it loads the launcher', async () => {
      const { loadWidget, opened } = start();
      await settle();
      expect(opened).toHaveLength(1);
      expect(loadWidget).not.toHaveBeenCalled();
      opened[0]?.sync();
      await settle();
      expect(loadWidget).toHaveBeenCalledTimes(1);
    });

    it('loads the launcher at the deadline when the list never syncs', async () => {
      vi.useFakeTimers();
      const { loadWidget } = start();
      await vi.advanceTimersByTimeAsync(FEEDBACK_WIDGET_DEADLINE_MS - 1);
      expect(loadWidget).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(loadWidget).toHaveBeenCalledTimes(1);
    });

    it('loads it once when the sync and the deadline both arrive', async () => {
      vi.useFakeTimers();
      const { loadWidget, opened } = start();
      await vi.advanceTimersByTimeAsync(10);
      opened[0]?.sync();
      await vi.advanceTimersByTimeAsync(FEEDBACK_WIDGET_DEADLINE_MS);
      expect(loadWidget).toHaveBeenCalledTimes(1);
    });
  });
});
