/**
 * What a street map's popup may hold: words, or a small card. Read here for
 * markers and points (`map-spec.ts`) and for GeoJSON layers
 * (`components/src/layers.ts`), drawn by `components/src/popup-node.ts`.
 *
 * A card is a title, lines and one link. It is data, never markup: every
 * field reaches the page as a text node, so it can carry no script and no
 * event handler, and its link is kept only when it is an http(s) URL. A
 * layer's card fields are templates filled from the tapped feature, so the
 * link is checked again once filled.
 */

/** A popup's card. */
export interface MapCard {
  title?: string;
  /** At most `CARD_LINES` lines, each one paragraph of text. */
  lines?: string[];
  /** Opens in a new tab. `text` defaults to the href. */
  link?: { href: string; text?: string };
}

/** Words, or a card. */
export type MapPopup = string | MapCard;

export const CARD_LINES = 20;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const text = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

/** True for an http(s) URL, the only links a card keeps. */
export function isWebHref(href: string): boolean {
  return /^https?:\/\/[^\s]/i.test(href.trim());
}

export type PopupRead = { ok: true; value: MapPopup | undefined } | { ok: false; error: string };

/** Read a `popup` prop: text, a number, a card, or nothing. `at` names it in
 *  the error, e.g. `markers[3].popup`. A card with no field is nothing.
 *
 *  `templated` is a layer's card, whose fields are `{key}` templates: its
 *  link may also start with a whole key (`{url}`), since only the filled
 *  value can be judged, and `popup-node.ts` judges it once filled. */
export function readPopup(v: unknown, at: string, templated = false): PopupRead {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  const words = text(v);
  if (words !== undefined) return { ok: true, value: words };
  const bad = (why: string): PopupRead => ({ ok: false, error: `${at} ${why}` });
  if (!isRecord(v)) return bad('must be text or a card: { title, lines, link }');
  const card: MapCard = {};
  if (v.title !== undefined) {
    const title = text(v.title);
    if (title === undefined) return bad('title must be text');
    card.title = title;
  }
  if (v.lines !== undefined) {
    const lines = Array.isArray(v.lines) ? v.lines.map(text) : null;
    if (!lines || lines.some((l) => l === undefined) || lines.length > CARD_LINES) {
      return bad(`lines must be a list of at most ${CARD_LINES} texts`);
    }
    card.lines = lines as string[];
  }
  if (v.link !== undefined) {
    const link = v.link;
    const href = isRecord(link) ? text(link.href) : undefined;
    const keyed = templated && href !== undefined && /^\s*\{[^{}]+\}/.test(href);
    if (href === undefined || !(isWebHref(href) || keyed)) {
      return bad('link.href must be an http(s) URL');
    }
    const label = isRecord(link) ? text(link.text) : undefined;
    card.link = label === undefined ? { href } : { href, text: label };
  }
  return { ok: true, value: Object.keys(card).length > 0 ? card : undefined };
}

/** Fill `{key}` in `template` from `props`, as text. A key the feature
 *  lacks, or whose value is not a string, number or boolean, fills empty. */
export function popupText(template: string, props: Record<string, unknown>): string {
  return template.replace(/\{([^{}]{1,64})\}/g, (_, key: string) => {
    const v = props[key.trim()];
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : '';
  });
}
