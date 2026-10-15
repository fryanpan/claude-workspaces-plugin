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

/** The relative specifiers of a minified ESM file's static imports. */
export function staticImports(code: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[;}\s])import\s*(?:[\w$*{}\s,]*?from\s*)?["'](\.\/[^"']+\.js)["']/g;
  for (const m of code.matchAll(re)) if (m[1]) out.add(m[1].slice(2));
  return [...out];
}

/** Every chunk `entry` reaches through static imports, nearest first. */
export function staticChunkClosure(entry: string, read: (name: string) => string | null): string[] {
  const seen = new Set<string>([entry]);
  const order: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const code = read(queue.shift() as string);
    if (code === null) continue;
    for (const dep of staticImports(code)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      order.push(dep);
      queue.push(dep);
    }
  }
  return order;
}

/** `html` with one preload link per chunk, at the end of its head. */
export function injectModulePreloads(html: string, chunks: readonly string[]): string {
  if (chunks.length === 0) return html;
  const links = chunks.map((c) => `<link rel="modulepreload" href="/app/${c}" />`).join('\n    ');
  const at = html.indexOf('</head>');
  if (at === -1) return html;
  return `${html.slice(0, at)}  ${links}\n  ${html.slice(at)}`;
}
