/**
 * Both Mermaid render paths the app ships, built for a real browser, with a
 * hostile diagram to feed them.
 *
 * `mermaid-strict-driver.ts` bundles this, calls `window.cwMermaidRender` with each
 * hostile diagram on each path, clicks what the diagram drew, and reads `window.cwMermaidRan` —
 * the list every payload pushes its name onto if it ever runs. The paths are
 * the SHIPPED modules, bundled from source: the doc editor's code-block node
 * view (`MermaidCodeBlock`, which the review editor and the redline editor
 * both mount) and `renderMarkdown` in `preview.ts`.
 *
 * Mermaid does not render under happy-dom — its parser reads the diagram
 * twice over there and every source fails to parse — so the fake-DOM suite
 * cannot see this.
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { MermaidCodeBlock } from '../src/mermaid-code-block.ts';
import { renderMarkdown } from '../src/preview.ts';

export type RenderPath = 'code-block' | 'preview';

declare global {
  interface Window {
    cwMermaidRan: string[];
    cwMermaidHit: (payload: number) => void;
    cwMermaidRender: (path: RenderPath, source: string) => Promise<string>;
  }
}

window.cwMermaidRan = [];
window.cwMermaidHit = (payload) => window.cwMermaidRan.push(`payload-${payload}`);

function codeBlockHtml(source: string): string {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.appendChild(code);
  return pre.outerHTML;
}

let renders = 0;
window.cwMermaidRender = async (path, source) => {
  const host = document.createElement('div');
  host.id = `render-${++renders}`;
  document.body.appendChild(host);
  if (path === 'code-block') {
    new Editor({
      element: host,
      extensions: [StarterKit.configure({ codeBlock: false }), MermaidCodeBlock],
      content: codeBlockHtml(source),
    });
    return host.id;
  }
  await renderMarkdown(`\`\`\`mermaid\n${source}\n\`\`\`\n`, host);
  return host.id;
};
