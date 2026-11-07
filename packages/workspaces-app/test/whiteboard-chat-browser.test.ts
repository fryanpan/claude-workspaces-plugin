/**
 * The chat with the lead on a whiteboard, as on every other page of a board,
 * in a real browser at 1180x820 and 430x932. Opening a whiteboard must not
 * leave the conversation behind (Bryan: a whiteboard link in the voice chat
 * "didn't open"). `whiteboard-chat-browser-driver.ts` drives a real server
 * and the real bundles; these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { SizeRun, WhiteboardChatRun } from './whiteboard-chat-browser-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'whiteboard-chat-browser-driver.ts');
/** One bundle build, ten browser launches at each of two sizes. */
const SUITE_MS = 390_000;
const SPAWN_MS = 380_000;
/** The product's bar for a change reaching an open page, which is the
 *  behaviour under test here, so these two are real times. */
const LIVE_MS = 1000;

let run: WhiteboardChatRun | null = null;
const result = (): WhiteboardChatRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};
const size = (width: number): SizeRun => {
  const s = result().sizes.find((x) => x.width === width);
  if (!s) throw new Error(`no run at ${width}`);
  return s;
};

describe.skipIf(CHROME === null)('the lead chat on a whiteboard', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    process.stderr.write(r.stderr.split('\n').slice(-12).join('\n'));
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as WhiteboardChatRun;
    process.stderr.write(`[whiteboard-chat] ${JSON.stringify(run.sizes)}\n`);
  }, SUITE_MS);

  for (const width of [1180, 430]) {
    describe(`at ${width} wide`, () => {
      it('shows the board’s nav bar a mock page shows', () => {
        const { mockPage, whiteboardPage } = size(width);
        // CONTROL: the mock page draws the four pages this compares against.
        expect(mockPage.nav?.links.map((l) => l[1])).toEqual([
          'Home',
          'Tasks',
          'Library',
          'Activity',
        ]);
        expect(whiteboardPage.nav).toEqual(mockPage.nav);
      }, 60_000);

      it('shows the top bar a doc page shows, beside that nav', () => {
        const { docPage, whiteboardPage } = size(width);
        // CONTROL: the doc page draws the bar this compares against.
        expect(docPage.bar?.height).toBeGreaterThan(0);
        expect(docPage.bar?.people).toBe(true);
        expect(whiteboardPage.bar).toEqual({
          ...docPage.bar,
          width: whiteboardPage.bar?.width,
          title: 'Ferry flow',
        });
      }, 60_000);

      it('shows what an agent draws on an open whiteboard within a second, with no reload', () => {
        const d = size(width).liveDraw;
        expect(d.afterDraw).toBe(d.before + 1);
        expect(d.afterReplace).toBe(1);
        expect(d.inkAfter).toBeGreaterThan(d.inkBefore);
        expect(d.noReload).toBe(true);
        expect(d.drawMs).toBeGreaterThanOrEqual(0);
        expect(d.drawMs).toBeLessThan(LIVE_MS);
        expect(d.replaceMs).toBeGreaterThanOrEqual(0);
        expect(d.replaceMs).toBeLessThan(LIVE_MS);
      }, 60_000);

      it('shows the chat and voice control a doc page shows', () => {
        const { docChat, whiteboardChat } = size(width);
        // CONTROL: the doc page's chat drew, opened and listened.
        expect(docChat.button).not.toBeNull();
        expect(docChat.pane).toBe(true);
        expect(docChat.listening).toBe(true);
        expect({ ...whiteboardChat, messageIds: [] }).toEqual({
          ...docChat,
          button: whiteboardChat.button,
          messageIds: [],
        });
      }, 60_000);

      it('shows the lead within a second of a person moving in, and of the lead pointing', () => {
        const moved = size(width).presence;
        if ('error' in moved) throw new Error(moved.error);
        expect(moved.arrivalMs).toBeLessThan(LIVE_MS);
        expect(moved.liveMs).toBeLessThan(LIVE_MS);
      }, 60_000);

      it('says where a question was asked, and shows the answer with no reload', () => {
        const { whiteboard, workspaceId } = result();
        expect(size(width).live).toEqual({
          link: `/workspaces/${workspaceId}/whiteboards/${whiteboard}`,
          surface: 'doc',
          docId: whiteboard,
          answerShown: true,
        });
      }, 60_000);

      for (const start of ['doc', 'home'] as const) {
        it(`a whiteboard link tapped during a voice chat on ${start} lands there, the chat still in voice`, () => {
          const link = size(width).links.find((l) => l.start === start);
          expect(link?.address).toBe(link?.expected);
          expect(link?.ready).toBe(true);
          expect(link?.listening).toBe(true);
          expect(link?.canvasCovered).toBe(false);
          expect(link?.conversation.listening).toBe(true);
          // The same conversation: everything the chat held before the tap.
          for (const id of link?.before.messageIds ?? []) {
            expect(link?.conversation.messageIds).toContain(id);
          }
        }, 60_000);
      }

      it('keeps Excalidraw’s keys and pointer, and its controls clear of the agent button', () => {
        const c = size(width).canvas;
        expect(c.toolAfterKey).toBe('rectangle');
        expect(c.drew).toBe(1);
        expect(c.closed.buttonOnControl).toBeNull();
        expect(c.closed.canvasFits).toBe(true);
        expect(c.closed.scroll).toEqual([0, 0]);
        expect(c.voiceBar.shown).toBe(true);
        expect(c.voiceBar.canvas.barOnControl).toBeNull();
      }, 60_000);

      it('leaves the canvas alone while the reader types to the lead', () => {
        const c = size(width).canvas;
        expect(c.chatOpen).toBe(true);
        expect(c.composer).toBe('reed');
        expect(c.toolAfterTyping).toBe(c.toolBeforeTyping);
        expect(c.elementsWhileTyping).toBe(0);
      }, 60_000);
    });
  }

  it('keeps Excalidraw’s desktop layout beside the docked chat at 1180', () => {
    const { open } = size(1180).canvas;
    expect(open.canvasFits).toBe(true);
    expect(open.buttonOnControl).toBeNull();
    expect(open.phoneLayout).toBe(false);
    // CONTROL: the phone layout this rules out is the one 430 wide draws.
    expect(size(430).canvas.open.phoneLayout).toBe(true);
  }, 60_000);

  it('keeps that layout at 1180 for a chat dragged as wide as it goes', () => {
    const dock = size(1180).canvas.wideDock;
    expect(dock?.phoneLayout).toBe(false);
    expect(dock?.stage.width).toBeGreaterThanOrEqual(730);
    expect(dock?.buttonOnControl).toBeNull();
  }, 60_000);

  it('moves the agent button off Excalidraw’s phone layout on a wide screen too small for the other', () => {
    const dock = size(1180).canvas.narrowDock;
    // CONTROL: this screen really did bring on the phone layout.
    expect(dock?.phoneLayout).toBe(true);
    expect(dock?.buttonOnControl).toBeNull();
  }, 60_000);

  it.each(['whiteboard', 'mock'] as const)(
    'moves the chat’s sheet out of the way of a page chosen in the %s’s nav',
    (page) => {
      const leave = size(430).navLeave?.[page];
      // CONTROL: the sheet really was open when the nav was tapped.
      expect(leave?.sheetBefore).toBe(true);
      expect(leave?.landed).toMatch(/\/library$/);
      expect(leave?.paneAfter).toBe(false);
    },
    60_000,
  );
});
