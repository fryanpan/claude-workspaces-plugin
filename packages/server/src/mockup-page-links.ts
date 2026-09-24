/**
 * Root-relative page links in a mockup's HTML, and the warning they earn.
 *
 * A mockup is served at `/workspaces/<ws>/mockups/<docId>`. A link written as
 * `/projects/harborlight/` resolves against the workspaces host, not the site
 * the page came from, so clicking it lands on an error page with no widget.
 * The mockup route already handles assets, so only navigation counts here:
 * `<a href>` and `<form action>`. A page of a multi-page site belongs on
 * `attach_app`, whose proxy keeps those links on the site.
 *
 * A warning, not a refusal: the page itself still renders and can still be
 * commented on. The caller learns at bind time which clicks will break,
 * instead of the reviewer learning it by clicking one.
 */

/** How many links the warning names; the count covers the rest. */
export const NAMED_LINK_LIMIT = 5;

// A tag opening `<a` or `<form`, then its attributes up to the closing `>`.
const TAG = /<(a|form)\b([^>]*)>/gi;
// One attribute, quoted either way or bare.
const ATTR = /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** Distinct root-relative `<a href>` / `<form action>` values, in page order.
 *  `//host/x` is protocol-relative, not root-relative, and is left out. */
export function rootRelativePageLinks(html: string): string[] {
  const found = new Set<string>();
  for (const tag of html.matchAll(TAG)) {
    const wanted = tag[1]?.toLowerCase() === 'a' ? 'href' : 'action';
    for (const attr of (tag[2] ?? '').matchAll(ATTR)) {
      if (attr[1]?.toLowerCase() !== wanted) continue;
      const value = (attr[2] ?? attr[3] ?? attr[4] ?? '').trim();
      if (value.startsWith('/') && !value.startsWith('//')) found.add(value);
    }
  }
  return [...found];
}

/** An app already attached to the board, which serves the same site whole. */
export interface BoardApp {
  docId: string;
  reviewUrl?: string;
}

export interface MockupLinkWarning {
  message: string;
  /** The first `NAMED_LINK_LIMIT` links. */
  links: string[];
  /** Every distinct root-relative page link on the page. */
  count: number;
  /** The board's app address, when it has one to share instead. */
  appUrl?: string;
}

/** The warning for these links, or undefined when there are none. */
export function mockupLinkWarning(
  links: readonly string[],
  app?: BoardApp,
): MockupLinkWarning | undefined {
  if (links.length === 0) return undefined;
  const named = links.slice(0, NAMED_LINK_LIMIT);
  const more = links.length > named.length ? `, and ${links.length - named.length} more` : '';
  const noun = links.length === 1 ? 'link' : 'links';
  const head = `This page has ${links.length} root-relative page ${noun} (${named.join(', ')}${more}). Inside a mockup they resolve against the workspaces host, so a reviewer who clicks one gets an error page with no widget.`;
  const appUrl = app?.reviewUrl;
  const tail = appUrl
    ? ` This board already serves the site as an app: share ${appUrl} instead.`
    : ' For a multi-page site, serve it with attach_app instead, which keeps those links on the site.';
  return {
    message: head + tail,
    links: named,
    count: links.length,
    ...(appUrl ? { appUrl } : {}),
  };
}
