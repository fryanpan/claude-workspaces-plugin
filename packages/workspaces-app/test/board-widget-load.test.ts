/**
 * The board loads the comment widget itself, into its own bundle.
 *
 * The shell used to add `<script src="/widget.esm.js">`, the bundle built for
 * other people's pages, which carries its own Yjs — two copies on every board.
 * Now the shell renders only the element and `bootBoard` imports the widget,
 * so it shares the board's Yjs. `check:client-boot` proves the one-copy half
 * in a real browser; this pins the decision: load it when the shell asked,
 * before anything that could fail, and not otherwise.
 *
 * All fixtures synthetic.
 */
import { describe, expect, it, vi } from 'vitest';
import { bootBoard } from '../src/board/board-app.ts';
import {
  fakeHistory,
  fakeLocation,
  fakeSockets,
  fakeStorage,
  installFakeBeacon,
  installFakeEventSource,
  installFakeServer,
  settle,
} from './boot-harness.ts';

installFakeServer();
installFakeEventSource();
installFakeBeacon();

async function bootWith(bodyHtml: string, url: string): Promise<ReturnType<typeof vi.fn>> {
  document.body.innerHTML = bodyHtml;
  const loadWidget = vi.fn(async () => undefined);
  await bootBoard({
    document,
    location: fakeLocation(url),
    history: fakeHistory(),
    localStorage: fakeStorage({ 'feedback-user-name': 'Ada' }),
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
});
