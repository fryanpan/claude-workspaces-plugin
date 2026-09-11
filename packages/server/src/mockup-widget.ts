/**
 * Attach-time widget injection for bound mockups.
 *
 * The widget used to be something an agent typed into the page it was about
 * to hand over. That worked until the page was a file git tracks: a benchmark
 * harness bound for a public remote was measured shipping
 * `<claude-feedback-widget … user="…">`, a real reviewer's name in it, inside a
 * committed HTML template,
 * and its report generator then hard-failed when the tag was absent — review
 * scaffolding had become a build dependency, and a reviewer's name had become
 * public record.
 *
 * So the server puts it in instead. `bind_mock` already reads the file on
 * every request; adding the embed on the way out means the page on disk never
 * has to carry it, which is the only version of "don't commit the widget" that
 * does not depend on an agent remembering. The source file renders bare
 * everywhere else — in a browser, in CI, in whatever the generator writes.
 *
 * `observe_url` gets no equivalent and cannot: it hands back an SSE URL for a
 * dev server this process never proxies, so there are no bytes here to rewrite.
 * A dev server still embeds the widget by hand — in a file its build ignores.
 */

/**
 * Marks that mean the page already embeds the widget itself. A page that opted
 * in explicitly keeps its own embed: it may be passing `view`, a `server-url`,
 * or calling `FeedbackWidget.init` with derived options, and a second copy
 * bolted on underneath would fight it for the same `docId`.
 *
 * A MENTION is not an embed. This used to match the name anywhere in the
 * page, and the board's own stylesheet carries `body:has(claude-feedback-widget)`
 * — so every mock that copied the real chrome was served without a widget, and
 * its reviewer could not comment. So the page is read the way a browser reads
 * it: comments and `<style>` bodies say nothing, markup embeds only by the
 * element's own tag or a `<script src>` naming the bundle, and a script body
 * counts on any mention, since code that names the widget is how a page mounts
 * it programmatically.
 *
 * But only a script the browser would RUN. A `type` that is not JavaScript or
 * `module` makes the element a data block — JSON, an import map, a template —
 * whose `src` is never fetched and whose body is never executed, so it can
 * mount nothing whatever it names. A mock carrying board.css as JSON was
 * served without a widget for exactly that selector. Parameters are ignored
 * where the spec would refuse them (`text/javascript; charset=…`): that errs
 * toward "already embedded", the same side as below.
 *
 * One left-to-right alternation rather than stripping each kind in turn, so
 * whichever span OPENS first owns the text up to its close — a `<!--` inside a
 * script string cannot swallow the embed after it, which it would if comments
 * were stripped first. An unclosed span matches nothing and stays markup, so
 * a malformed page errs toward "already embedded", never toward a second copy.
 */
const OPAQUE =
  /<!--[\s\S]*?-->|<style(?=[\s/>])[^>]*>[\s\S]*?<\/style\s*>|<script(?=[\s/>])([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const EMBED_IN_MARKUP = /<claude-feedback-widget\b|<script\b[^>]*widget\.iife\.js/i;
const EMBED_IN_SCRIPT = /claude-feedback-widget|widget\.iife\.js|FeedbackWidget\s*\.\s*init/i;
const BUNDLE = /widget\.iife\.js/i;

/** One attribute, name then an optional double-, single- or un-quoted value. */
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** The value of the first attribute called `name` — the one a browser keeps. */
function attr(attrs: string, name: string): string | undefined {
  for (const [, key, dq, sq, bare] of attrs.matchAll(ATTR)) {
    if (key?.toLowerCase() === name) return dq ?? sq ?? bare ?? '';
  }
  return undefined;
}

/** The HTML spec's JavaScript MIME type essences, plus `module`. */
const RUNNABLE = new Set([
  'module',
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

/**
 * Whether a browser would execute a `<script>` with these attributes. A type
 * holding a character reference (`text&#x2f;javascript`) is not decoded here,
 * so it counts as runnable — the "already embedded" side again.
 */
function runs(attrs: string): boolean {
  const type = attr(attrs, 'type')?.split(';')[0]?.trim().toLowerCase();
  return !type || type.includes('&') || RUNNABLE.has(type);
}

function alreadyEmbedded(html: string): boolean {
  let byScript = false;
  const markup = html.replace(OPAQUE, (_span, attrs?: string, body?: string) => {
    // A script's attributes embed only through `src`; a `data-*` naming the widget mounts nothing.
    if (
      attrs !== undefined &&
      runs(attrs) &&
      (BUNDLE.test(attr(attrs, 'src') ?? '') || EMBED_IN_SCRIPT.test(body ?? ''))
    )
      byScript = true;
    return ' ';
  });
  return byScript || EMBED_IN_MARKUP.test(markup);
}

/** Last `</body>`, case-insensitive — the insertion point when there is one. */
const BODY_CLOSE = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i;

const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The embed itself. No `user` attribute on purpose — the widget resolves the
 * reviewer from the browser it is running in (`resolveUser` in
 * `@claude-workspaces/core/identity`), so a name baked into markup does not identify
 * the reader, it RE-BRANDS them: whoever opens the page is seeded as that
 * person in a fresh browser. A shared review URL makes that everyone.
 *
 * `server-url` is omitted for the same class of reason — the widget defaults
 * its socket to the origin the bundle came from, which is this server however
 * the reader reached it (loopback, tailnet, LAN, tunnel). A literal host would
 * be wrong for every reader who arrived by a different route.
 *
 * `workspace-id` is NOT omitted and cannot be: the widget refuses to run
 * without it, because every resource it addresses lives under the board that
 * owns it. This server knows the board — it is the one in the URL the reader
 * opened — so the embed it writes always carries it. A hand-written embed on
 * someone else's page has to say it itself.
 */
export function widgetEmbed(docId: string, workspaceId: string): string {
  return (
    `<claude-feedback-widget workspace-id="${escapeAttr(workspaceId)}" ` +
    `doc-id="${escapeAttr(docId)}"></claude-feedback-widget>` +
    `<script src="/widget.iife.js"></script>`
  );
}

/**
 * Return `html` with the widget embed added, or unchanged when the page
 * already carries one. Appends when there is no `</body>` — a fragment or a
 * hand-written page without one is still a page a reviewer wants to comment on.
 */
export function injectWidget(html: string, docId: string, workspaceId: string): string {
  if (alreadyEmbedded(html)) return html;
  const embed = widgetEmbed(docId, workspaceId);
  if (BODY_CLOSE.test(html)) return html.replace(BODY_CLOSE, `${embed}$&`);
  return `${html}${embed}`;
}
