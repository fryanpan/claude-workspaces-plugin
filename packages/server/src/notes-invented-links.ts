/**
 * A link the note-taker was never given, unwrapped before it reaches the doc.
 *
 * WHY NOT THE PROMPT, AND WHY BESIDE `notes-edit-guard.ts`. The prompt already
 * says to cite only what it was handed. In a measured eval run it composed a
 * `web.archive.org` URL for a page nobody had mentioned, and a bare
 * `url:speech-recognition` that is not an address at all. A made-up citation
 * is not a formatting blemish: it is a claim, in the room's shared record,
 * that a source exists and says this — and a reader of the notes cannot tell
 * it was invented. So this is the same shape of answer the guard beside it is:
 * refused in the applier, where the model's cooperation is not required.
 *
 * WHAT SURVIVES. Only a URL the tick could actually have read:
 *
 *   - one the pipeline HANDED the composer — a matched board reference, a
 *     captured task, a resolved doc lookup, or a row this tick will offer as
 *     a suggestion (that one is written after the model, not by it, so a set
 *     that omitted it would strip the pipeline's own question);
 *   - one that appears VERBATIM in this tick's speech or in the doc as the
 *     tick read it, which is how a link a person typed, or an address
 *     somebody dictated, keeps working;
 *   - a `speaker:` tag, which is this pipeline's own inline mention and is
 *     already gated, per voice, by `normalizeSpeakerTags`.
 *
 * THE WORDS ARE KEPT AND ONLY THE LINK IS DROPPED. `[Whisper v3](https://…)`
 * becomes `Whisper v3`. The bullet was composed from speech that did happen;
 * it is the address that was imagined, and deleting the sentence would lose a
 * real note to a false footnote.
 *
 * MATCHING IS LENIENT ABOUT THE QUERY AND THE FRAGMENT and exact about
 * everything else. A suggestion href is the row's own URL plus `?suggest=1`,
 * so a comparison that demanded the whole string would refuse the pipeline's
 * own writing; a citation that reaches the right row with an extra parameter
 * on it is still that row. The PATH is never relaxed: that is the half that
 * says which thing is being cited.
 */

import { SUGGEST_PARAM, type prose } from '@claude-workspaces/core';

/** What the tick was given, as the check needs to see it. */
export interface NotesLinkSources {
  /** Every URL handed to this tick, in any of its forms. */
  urls: readonly string[];
  /** Text the tick could have read a URL out of — its speech, and the doc as
   *  it stood. Searched for the composed URL verbatim, nothing cleverer. */
  text: readonly string[];
}

/** The shape of a compose input this module reads. Structural on purpose:
 *  `NotesComposeInput` satisfies it without this module importing the notes
 *  pipeline, and the eval harness can hand it the same fields. */
export interface NotesLinkInputs {
  references?: readonly { url: string }[] | undefined;
  taskLinks?: readonly { url: string }[] | undefined;
  docLinks?: readonly { url: string }[] | undefined;
  suggestions?: readonly { url: string }[] | undefined;
  outline?: readonly { text: string }[] | undefined;
  /** This tick's settled turns. */
  turns?: readonly { text: string }[] | undefined;
}

/** Everything a tick was given, collected once, at the seam that has it all. */
export function notesLinkSources(input: NotesLinkInputs): NotesLinkSources {
  const urls: string[] = [];
  for (const list of [input.references, input.taskLinks, input.docLinks, input.suggestions]) {
    for (const item of list ?? []) urls.push(item.url);
  }
  const text: string[] = [];
  for (const entry of input.outline ?? []) text.push(entry.text);
  for (const turn of input.turns ?? []) text.push(turn.text);
  return { urls, text };
}

/**
 * Inline links, including the image form. The destination stops at the first
 * whitespace or closing paren, which is markdown's own rule for an unbracketed
 * destination, and an optional `"title"` after it is dropped with the link.
 */
const INLINE_LINK = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^()\s]*)(?:\s+"[^"]*")?\s*\)/g;

/** The scheme this pipeline's own inline speaker mentions carry. */
const SPEAKER_SCHEME = 'speaker:';

/**
 * A URL reduced to what two spellings of the same target share: no angle
 * brackets, no fragment, no `suggest` marker, no trailing slash, lowercased.
 */
function identity(raw: string): string {
  let url = raw.trim().replace(/^<(.*)>$/, '$1');
  const hash = url.indexOf('#');
  if (hash >= 0) url = url.slice(0, hash);
  const query = url.indexOf('?');
  if (query >= 0) {
    const kept = url
      .slice(query + 1)
      .split('&')
      .filter((p) => p !== `${SUGGEST_PARAM}=1`);
    url = url.slice(0, query) + (kept.length > 0 ? `?${kept.join('&')}` : '');
  }
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  return url.toLowerCase();
}

function allowed(raw: string, sources: NotesLinkSources): boolean {
  const url = raw.trim().replace(/^<(.*)>$/, '$1');
  if (url.length === 0) return true;
  if (url.toLowerCase().startsWith(SPEAKER_SCHEME)) return true;
  const wanted = identity(url);
  if (sources.urls.some((given) => identity(given) === wanted)) return true;
  return sources.text.some((t) => t.includes(url));
}

/** What one tick's links came to. */
export interface InventedLinkResult {
  /** The edits to apply, in order, with every invented link unwrapped. */
  edits: prose.BlockEdit[];
  /** The URLs dropped, in the order they were written. Empty is the healthy
   *  state, so a caller logs nothing for the ordinary tick. */
  dropped: string[];
}

/**
 * Unwrap every link in `edits` whose URL is not among the tick's inputs.
 *
 * An edit with no markdown (a delete) passes through untouched, and an edit
 * whose links all check out is returned as the same object, so nothing is
 * rewritten in the common case.
 */
export function stripInventedLinks(
  edits: readonly prose.BlockEdit[],
  sources: NotesLinkSources,
): InventedLinkResult {
  const dropped: string[] = [];
  const out = edits.map((edit) => {
    if (!('markdown' in edit)) return edit;
    const markdown = edit.markdown.replace(
      INLINE_LINK,
      // The image form's `!` goes with the link: `![a](url)` unwrapped to
      // `!a` would leave a stray mark where a picture was asked for.
      (whole: string, _bang: string, text: string, dest: string) => {
        if (allowed(dest, sources)) return whole;
        dropped.push(dest.trim());
        return text;
      },
    );
    return markdown === edit.markdown ? edit : { ...edit, markdown };
  });
  return { edits: out, dropped };
}

/**
 * The invented URLs in `edits`, changing nothing — the reading half, for the
 * eval report, which has to count what the applier would have dropped.
 */
export function findInventedLinks(
  edits: readonly prose.BlockEdit[],
  sources: NotesLinkSources,
): string[] {
  return stripInventedLinks(edits, sources).dropped;
}
