import {
  MAX_VOICE_TARGETS,
  MAX_VOICE_TARGET_INDEX,
  VOICE_TARGET_TEXT,
  type VoiceTarget,
} from '@claude-workspaces/core';
import { IGNORE_ATTR, TAG } from '../widget-picker.ts';

/**
 * The page, as a list of the things a person could be talking about.
 *
 * The server chooses which element a spoken comment is about, and it never
 * sees the DOM — so the page describes itself in words: each candidate's tag,
 * its visible text, the label a screen reader would say, and the id and class
 * names a mock author chose ("goal", "chip"). An index is the only name that
 * crosses the socket; `elements[i]` turns it back into the element here.
 *
 * WHAT IS LEFT OUT, AND WHY. A wrapper with one child and no words of its own
 * says nothing its child does not, and every entry is paid for on every tick
 * of the model — so wrappers collapse into their child. Hidden and zero-size
 * elements are not what anyone is looking at. The widget's own chrome is not
 * the page.
 */

export interface TargetCatalog {
  targets: VoiceTarget[];
  /** By target index. */
  elements: Map<number, HTMLElement>;
}

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'br']);
/** Elements that are a thing to talk about even when they carry no words. */
const NAMED =
  /^(button|a|input|select|textarea|img|video|canvas|svg|h[1-6]|li|nav|header|footer|section|article|aside|form|dialog|table|label|summary|progress)$/;

/** Shown on screen with some area — the default; tests inject their own. */
export function isShown(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width * r.height < 16) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
}

function squash(s: string | null | undefined, max = VOICE_TARGET_TEXT): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** All the text inside, with a space at every element edge: "Design" and
 *  "$12,000" in two cells read as two words, not "Design$12,000". */
function spacedText(el: Element, max = VOICE_TARGET_TEXT): string {
  let s = '';
  const add = (n: Node): void => {
    for (const c of n.childNodes) {
      if (s.length > max * 2) return;
      if (c.nodeType === 3) s += c.textContent ?? '';
      else if (c.nodeType === 1 && !SKIP.has((c as Element).tagName.toLowerCase())) {
        s += ' ';
        add(c);
        s += ' ';
      }
    }
  };
  add(el);
  return squash(s, max);
}

function ownText(el: Element): string {
  let s = '';
  for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent ?? '';
  return squash(s);
}

/** Id and up to three class names, leaving out generated ones (`css-1x9f2`). */
function hintOf(el: Element): string {
  const words: string[] = [];
  if (el.id && el.id.length <= 32) words.push(`#${el.id}`);
  for (const c of Array.from(el.classList).slice(0, 6)) {
    if (words.length >= 4) break;
    if (c.length <= 24 && !/\d{3}|__|^cfw|^(css|sc|jsx|emotion|svelte)-/.test(c))
      words.push(`.${c}`);
  }
  return words.join(' ');
}

/**
 * `ids` is the recording's numbering: pass the same map to every collection
 * in one recording and an element keeps its index across them, a new element
 * taking the next unused one (`MAX_VOICE_TARGET_INDEX`). `elements` is then
 * keyed by that index, not by position.
 */
export function collectTargets(
  root: ParentNode = document.body,
  shown: (el: HTMLElement) => boolean = isShown,
  ids: Map<Element, number> = new Map(),
): TargetCatalog {
  const targets: VoiceTarget[] = [];
  const elements = new Map<number, HTMLElement>();
  const indexOf = new Map<Element, number>();
  const walk = (el: Element): void => {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag) || tag === TAG || el.hasAttribute(IGNORE_ATTR)) return;
    if (!(el instanceof HTMLElement) && tag !== 'svg') return;
    if (el instanceof HTMLElement && !shown(el)) return;
    const own = ownText(el);
    const label = squash(
      el.getAttribute('aria-label') ??
        el.getAttribute('title') ??
        el.getAttribute('alt') ??
        el.getAttribute('placeholder'),
    );
    const hint = hintOf(el);
    // A wrapper with one child and nothing of its own to say is its child.
    const wrapper = el.children.length === 1 && !own && !label && !hint && !NAMED.test(tag);
    const worth = !wrapper && (own || label || hint || NAMED.test(tag));
    if (
      worth &&
      targets.length < MAX_VOICE_TARGETS &&
      (ids.has(el) || ids.size <= MAX_VOICE_TARGET_INDEX) &&
      el instanceof HTMLElement
    ) {
      let parent: number | undefined;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const at = indexOf.get(p);
        if (at !== undefined) {
          parent = at;
          break;
        }
      }
      let i = ids.get(el);
      if (i === undefined) {
        i = ids.size;
        ids.set(el, i);
      }
      indexOf.set(el, i);
      elements.set(i, el);
      targets.push({
        i,
        tag,
        text: spacedText(el),
        ...(label ? { label } : {}),
        ...(hint ? { hint } : {}),
        ...(parent !== undefined ? { parent } : {}),
      });
    }
    if (tag === 'svg') return;
    for (const child of el.children) walk(child);
  };
  for (const child of Array.from((root as Element).children ?? [])) walk(child);
  return { targets, elements };
}
