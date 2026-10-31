// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
/**
 * A `::sfworks{block="…"}` paragraph shows the board app's live frame under
 * it. The promises: the frame is a view decoration, so the stored markdown is
 * the line as typed; it is sandboxed without same-origin; it takes a height
 * only from its own window; and an unmapped name or a bad block shows nothing.
 * Fixtures synthetic; the repo is public.
 */
import type { BoardEmbeds } from '@claude-workspaces/core/board-embeds';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardEmbedFrames } from '../src/doc/board-embed-frames.ts';
import { installSheets, styleOf } from './css-harness.ts';

const MAP: BoardEmbeds = {
  sfworks: { appDocId: 'd-app1', pathTemplate: '{mount}/embed/bike/{block}/' },
};
const ORIGIN = 'https://harborlight.example';
const AT_ORIGIN: BoardEmbeds = {
  sfworks: { origin: ORIGIN, pathTemplate: '{origin}/embed/bike/{block}/' },
};
const LINE = '::sfworks{block="goal-chart"}';
const DOC = `# Riverbend\n\nAlice wrote this.\n\n${LINE}\n\nBob wrote that.`;

async function mount(markdown: string, embeds: BoardEmbeds | null = MAP) {
  const el = document.createElement('div');
  el.id = 'editor';
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit,
      Markdown.configure({ html: false, tightLists: true, linkify: true, breaks: false }),
      BoardEmbedFrames.configure({ workspaceId: 'w-saltmarsh', load: async () => embeds }),
    ],
    content: markdown,
  });
  // The mapping arrives on a promise; let it land and the decorations rebuild.
  await new Promise((r) => setTimeout(r, 0));
  return { editor, el };
}

const markdownOf = (editor: Editor): string =>
  (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();

const frames = (el: HTMLElement): HTMLIFrameElement[] => [...el.querySelectorAll('iframe')];

afterEach(() => {
  document.body.innerHTML = '';
});

describe('board embed frames', () => {
  it('renders a sandboxed lazy frame at the mapped path, and leaves the markdown alone', async () => {
    const { editor, el } = await mount(DOC);
    const [frame, ...rest] = frames(el);
    expect(rest).toHaveLength(0);
    expect(frame?.getAttribute('src')).toBe(
      '/workspaces/w-saltmarsh/apps/d-app1/embed/bike/goal-chart/?cw-frame=1&cw-embed=1',
    );
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('loading')).toBe('lazy');
    expect(markdownOf(editor)).toBe(DOC);
    // The line is still an ordinary paragraph holding its own text.
    const texts: string[] = [];
    editor.state.doc.forEach((n) => texts.push(`${n.type.name}:${n.textContent}`));
    expect(texts).toContain(`paragraph:${LINE}`);
    editor.destroy();
  });

  it('takes a height only from its own frame, clamped', async () => {
    const { editor, el } = await mount(DOC);
    const frame = frames(el)[0] as HTMLIFrameElement;
    // The frame's page never loads here (child navigation is off above), so
    // it is given a window of its own to post from.
    const own = { name: 'frame window' } as unknown as Window;
    Object.defineProperty(frame, 'contentWindow', { value: own });
    const before = frame.style.height;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'sfworks:height', block: 'goal-chart', height: 640 },
        source: window,
      }),
    );
    expect(frame.style.height).toBe(before);
    // A 41-row table on a phone is well past 2,000px; it gets all of it.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'sfworks:height', block: 'goal-chart', height: 4500 },
        source: own,
      }),
    );
    expect(frame.style.height).toBe('4500px');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'sfworks:height', block: 'goal-chart', height: 50000 },
        source: own,
      }),
    );
    expect(frame.style.height).toBe('10000px');
    editor.destroy();
  });

  it('loads an origin entry from that origin, with its own origin kept', async () => {
    const { editor, el } = await mount(DOC, AT_ORIGIN);
    const frame = frames(el)[0];
    expect(frame?.getAttribute('src')).toBe('https://harborlight.example/embed/bike/goal-chart/');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.getAttribute('loading')).toBe('lazy');
    editor.destroy();
  });

  it("takes an origin frame's height only from a message carrying that origin", async () => {
    const { editor, el } = await mount(DOC, AT_ORIGIN);
    const frame = frames(el)[0] as HTMLIFrameElement;
    const own = { name: 'frame window' } as unknown as Window;
    Object.defineProperty(frame, 'contentWindow', { value: own });
    const before = frame.style.height;
    const send = (origin: string, height: number): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'sfworks:height', block: 'goal-chart', height },
          source: own,
          origin,
        }),
      );
    };
    send('https://riverbend.example', 640);
    send('null', 640);
    expect(frame.style.height).toBe(before);
    send(ORIGIN, 640);
    expect(frame.style.height).toBe('640px');
    editor.destroy();
  });

  it('starts inert so the doc scrolls over it; a tap activates, a tap outside or Escape puts it back', async () => {
    const cleanup = installSheets('styles.css', 'doc.css');
    const { editor, el } = await mount(DOC);
    const frame = frames(el)[0] as HTMLIFrameElement;
    const wrap = frame.parentElement as HTMLElement;
    const hint = wrap.querySelector('.board-embed-hint') as HTMLElement;
    expect(frame.hasAttribute('referrerpolicy')).toBe(false);
    expect(hint.textContent).toBe('Tap to interact');
    expect(styleOf(frame).pointerEvents).toBe('none');
    wrap.click();
    expect(styleOf(frame).pointerEvents).toBe('auto');
    expect(styleOf(hint).display).toBe('none');
    // A tap inside the active frame's box keeps it active.
    wrap.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(styleOf(frame).pointerEvents).toBe('auto');
    const outside = el.querySelector('h1') as HTMLElement;
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(styleOf(frame).pointerEvents).toBe('none');
    wrap.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(styleOf(frame).pointerEvents).toBe('none');
    editor.destroy();
    cleanup();
  });

  it('reads the mapping only once a directive line exists', async () => {
    let reads = 0;
    const el = document.createElement('div');
    document.body.appendChild(el);
    const editor = new Editor({
      element: el,
      extensions: [
        StarterKit,
        Markdown,
        BoardEmbedFrames.configure({
          workspaceId: 'w-saltmarsh',
          load: async () => {
            reads++;
            return MAP;
          },
        }),
      ],
      content: 'Alice wrote this.',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(reads).toBe(0);
    editor.commands.insertContentAt(editor.state.doc.content.size, `<p>${LINE}</p>`);
    await new Promise((r) => setTimeout(r, 0));
    expect(reads).toBe(1);
    expect(frames(el)).toHaveLength(1);
    editor.destroy();
  });

  it('shows nothing for an unmapped name, a bad block, or no mapping', async () => {
    for (const [md, map] of [
      ['::other{block="goal-chart"}', MAP],
      ['::sfworks{block="../up"}', MAP],
      ['before ::sfworks{block="goal-chart"}', MAP],
      [LINE, null],
    ] as const) {
      const { editor, el } = await mount(md, map);
      expect(frames(el)).toHaveLength(0);
      editor.destroy();
    }
  });

  it('frames a ::html{src} page from the doc folder, opaque, with no mapping needed', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const editor = new Editor({
      element: el,
      extensions: [
        StarterKit,
        Markdown.configure({ html: false, tightLists: true, linkify: true, breaks: false }),
        BoardEmbedFrames.configure({
          workspaceId: 'w-saltmarsh',
          docId: 'd-riverbend',
          load: async () => null,
        }),
      ],
      content: 'Alice wrote this.\n\n::html{src="map/index.html"}\n\n::html{src="../up.html"}',
    });
    await new Promise((r) => setTimeout(r, 0));
    const [frame, ...rest] = frames(el);
    expect(rest).toHaveLength(0);
    expect(frame?.getAttribute('src')).toBe(
      '/workspaces/w-saltmarsh/docs/d-riverbend/files/map/index.html',
    );
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.dataset.embedFiles).toBe('/workspaces/w-saltmarsh/docs/d-riverbend/files/');
    editor.destroy();
  });
});
