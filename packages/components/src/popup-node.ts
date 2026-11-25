/**
 * The DOM of a popup and a tooltip (`core/map-card.ts` says what a popup may
 * hold). Every word is a text node, so nothing in a popup or a tooltip can
 * run, and a card's link is kept only when it is an http(s) URL once filled.
 */
import { type MapPopup, isWebHref } from '@claude-workspaces/core/map-card';

/** `fill` fills a layer's `{key}` templates; markers' words pass as they are. */
type Fill = (template: string) => string;
const asIs: Fill = (s) => s;

export function popupNode(doc: Document, popup: MapPopup, fill: Fill = asIs): HTMLElement {
  const root = doc.createElement('div');
  root.className = 'cw-map-popup';
  if (typeof popup === 'string') {
    root.textContent = fill(popup);
    return root;
  }
  root.classList.add('cw-map-card');
  const add = (tag: 'strong' | 'p', cls: string, words: string): void => {
    const node = doc.createElement(tag);
    node.className = cls;
    node.textContent = words;
    root.appendChild(node);
  };
  if (popup.title !== undefined) add('strong', 'cw-map-card-title', fill(popup.title));
  for (const line of popup.lines ?? []) add('p', 'cw-map-card-line', fill(line));
  if (popup.link) {
    const href = fill(popup.link.href).trim();
    if (isWebHref(href) && webUrl(href)) {
      const a = doc.createElement('a');
      a.className = 'cw-map-card-link';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = popup.link.text === undefined ? href : fill(popup.link.text);
      root.appendChild(a);
    }
  }
  return root;
}

/** True when `href` parses as an http(s) URL. */
function webUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function tooltipNode(doc: Document, words: string): HTMLElement {
  const node = doc.createElement('div');
  node.className = 'cw-map-tooltip';
  node.textContent = words;
  return node;
}
