import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { mountDiffView } from '../src/edit/edit-diff-view.ts';
import { mountCommentMarkdown, renderMarkdown } from '../src/widget-comment-markdown.ts';
import type { FeedbackWidgetEl } from '../src/widget.ts';

/**
 * A comment's markdown, drawn as nodes in a thread's popover on a mock or a
 * dev server. Comment text is untrusted: anyone the page is shared with can
 * write one, so the cases that matter most are the ones that must stay inert.
 *
 * Fixtures are invented: the Harborlight and Riverbend piers.
 */

function render(text: string): HTMLElement {
  const box = document.createElement('div');
  box.append(renderMarkdown(text));
  return box;
}

describe('a comment rendered from markdown', () => {
  it('draws a link, bold, italics, inline code and a list', () => {
    const box = render(
      'See [the timetable](https://example.com/riverbend?a=1&b=2) for **Harborlight**.\n' +
        'It is _not_ final; run `bun run staging` first.\n\n' +
        '- north pier\n- *south* pier\n\n1. one\n2. two',
    );
    const a = box.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com/riverbend?a=1&b=2');
    expect(a?.textContent).toBe('the timetable');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(box.querySelector('strong')?.textContent).toBe('Harborlight');
    expect([...box.querySelectorAll('em')].map((e) => e.textContent)).toEqual(['not', 'south']);
    expect(box.querySelector('code')?.textContent).toBe('bun run staging');
    expect([...box.querySelectorAll('ul > li')].map((e) => e.textContent)).toEqual([
      'north pier',
      'south pier',
    ]);
    expect([...box.querySelectorAll('ol > li')].map((e) => e.textContent)).toEqual(['one', 'two']);
    expect(box.querySelectorAll('p')).toHaveLength(1);
  });

  it('keeps a plain comment as its words, with its line breaks', () => {
    const box = render('Which pier?\nThe north one.');
    expect(box.textContent).toBe('Which pier?The north one.');
    expect(box.querySelectorAll('br')).toHaveLength(1);
    expect(box.querySelector('a, strong, em, code, li')).toBeNull();
  });

  it('keeps a fenced block literal', () => {
    const box = render('```\n- not a list\n**not bold**\n```');
    expect(box.querySelector('pre code')?.textContent).toBe('- not a list\n**not bold**');
    expect(box.querySelector('li, strong')).toBeNull();
  });

  it('links mailto, and a label may carry marks', () => {
    const box = render('[**write** to Alice](mailto:alice@example.com)');
    const a = box.querySelector('a');
    expect(a?.getAttribute('href')).toBe('mailto:alice@example.com');
    expect(a?.querySelector('strong')?.textContent).toBe('write');
  });

  it('leaves a javascript: link as its words, with no link', () => {
    const box = render(
      '[x](javascript:alert(1)) and [y](data:text/html,hi) and [z](  JavaScript:alert(1))',
    );
    expect(box.querySelector('a')).toBeNull();
    expect(box.textContent).toContain('[x](javascript:alert(1))');
    expect(box.textContent).toContain('[y](data:text/html,hi)');
  });

  it('leaves raw HTML as text: no element is made from it', () => {
    const text = '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script> **ok**';
    const box = render(text);
    expect(box.querySelector('img, script')).toBeNull();
    expect(box.querySelector('strong')?.textContent).toBe('ok');
    expect(box.textContent).toBe(
      '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script> ok',
    );
  });
});

/** A widget stand-in holding one thread with `comments`, and its shadow. */
function widgetWith(comments: Array<{ text: string; pageEdits?: unknown }>): FeedbackWidgetEl {
  const ydoc = new Y.Doc();
  ydoc.getMap('threads').set('t1', new Y.Map(Object.entries({ comments })));
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  return Object.assign(host, { shadow, client: { ydoc } }) as unknown as FeedbackWidgetEl;
}

/** A popover drawn the way the budgeted bundle draws one: escaped words. */
function popover(w: FeedbackWidgetEl, text: string): HTMLElement {
  const pop = document.createElement('div');
  pop.className = 'thread-popover';
  pop.innerHTML = '<div class="comment"><div class="body"></div></div>';
  (pop.querySelector('.body') as HTMLElement).textContent = text;
  w.shadow.append(pop);
  return pop.querySelector('.body') as HTMLElement;
}

describe('the popover, once comment markdown is mounted', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('redraws a comment from its words as it appears', async () => {
    const w = widgetWith([{ text: 'Use **Riverbend**' }]);
    mountCommentMarkdown(w);
    const body = popover(w, 'Use **Riverbend**');
    await new Promise((r) => setTimeout(r, 0));
    expect(body.querySelector('strong')?.textContent).toBe('Riverbend');
  });

  it('leaves a page-edit comment for the diff view, mounted after it', async () => {
    const text = 'Edited 1 heading\n- Harborlight Street ~~Projects~~ **Works**';
    const w = widgetWith([{ text, pageEdits: [{ selector: 'h1' }] }]);
    // The order the page has: mic.js at load, edit.js later.
    mountCommentMarkdown(w);
    mountDiffView(w);
    const body = popover(w, text);
    await new Promise((r) => setTimeout(r, 0));
    expect(body.querySelector('ins')?.textContent).toBe('Works');
    expect(body.querySelector('strong, li')).toBeNull();
  });
});
