/**
 * `<link rel="modulepreload">` for every chunk an entry imports statically.
 *
 * With splitting on, the doc bundle's entry imports shared chunks, and a
 * browser only learns their names once the entry has downloaded and parsed —
 * one more round trip, in series, before the page can run. Naming them in the
 * shell lets the browser fetch them alongside the entry. Lazy chunks (an
 * `import()` such as mermaid's) are left out on purpose: preloading them would
 * put back the bytes splitting took off the first load.
 */

// The closure walk lives in core so the server can name the same chunks for
// the shells it renders itself (Home's `landingModulePreloads`).
export { staticChunkClosure, staticImports } from '@claude-workspaces/core/asset-manifest';

/** `html` with one preload link per chunk, at the end of its head. */
export function injectModulePreloads(html: string, chunks: readonly string[]): string {
  if (chunks.length === 0) return html;
  const links = chunks.map((c) => `<link rel="modulepreload" href="/app/${c}" />`).join('\n    ');
  const at = html.indexOf('</head>');
  if (at === -1) return html;
  return `${html.slice(0, at)}  ${links}\n  ${html.slice(at)}`;
}
