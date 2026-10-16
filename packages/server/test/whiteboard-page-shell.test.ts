/**
 * The whiteboard page's shell: what the browser needs before the bundle runs.
 * Rendered and parsed, not grepped, so a reordered attribute still passes.
 */
import { describe, expect, it } from 'bun:test';
import { renderWhiteboardShell } from '../src/whiteboard/page-shell.ts';

const parse = (html: string) => new HTMLRewriterProbe(html);

/** The few things the page reads off the shell, pulled out with HTMLRewriter. */
class HTMLRewriterProbe {
  readonly body: Record<string, string> = {};
  readonly stylesheets: string[] = [];
  readonly scripts: string[] = [];
  title = '';
  constructor(readonly html: string) {}
  async read(): Promise<this> {
    await new HTMLRewriter()
      .on('body', {
        element: (el) => {
          for (const [k, v] of el.attributes) this.body[k] = v;
        },
      })
      .on('link[rel=stylesheet]', {
        element: (el) => {
          this.stylesheets.push(el.getAttribute('href') ?? '');
        },
      })
      .on('script[type=module]', {
        element: (el) => {
          this.scripts.push(el.getAttribute('src') ?? '');
        },
      })
      .on('#wb-title', {
        text: (t) => {
          this.title += t.text;
        },
      })
      .transform(new Response(this.html))
      .text();
    return this;
  }
}

describe('the whiteboard shell', () => {
  it('names the doc and board for the bundle, and escapes the title', async () => {
    const page = await parse(
      renderWhiteboardShell(
        { workspaceId: 'w-1', docId: 'd-ferry', title: 'Ferry <flow>' },
        null,
      ),
    ).read();
    expect(page.body['data-workspace-id']).toBe('w-1');
    expect(page.body['data-doc-id']).toBe('d-ferry');
    expect(page.title).toBe('Ferry &lt;flow&gt;');
    expect(page.scripts).toEqual(['/app/whiteboard.js']);
  });

  it('loads the shared chrome first and the token layer last', async () => {
    const page = await parse(
      renderWhiteboardShell({ workspaceId: 'w', docId: 'd', title: 't' }, null, {
        'whiteboard.js': 'whiteboard.abc123.js',
      }),
    ).read();
    expect(page.stylesheets[0]).toBe('/app/styles.css');
    expect(page.stylesheets.at(-1)).toBe('/app/tokens.css');
    expect(page.stylesheets).toContain('/app/whiteboard/excalidraw.css');
    expect(page.scripts).toEqual(['/app/whiteboard.abc123.js']);
  });
});
