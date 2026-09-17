/**
 * Take the thread fields the widget never reads out of its copy of the thread
 * reader.
 *
 * `listThreads` (core `schema.ts`) and the review payload reader it calls
 * (`review-item-wire.ts`) are shared with the board and the review editor, so
 * they lift every field any surface shows off the CRDT. The widget renders a
 * pin, a card and the dock, and reads none of the fields below — measured by
 * searching the built bundle for any read of each name. Lifting a field nobody
 * reads is bytes on every host page with no reader, and the widget ships under
 * a hard gzip budget.
 *
 * So the build deletes the statements that lift them. The `Thread` the widget
 * holds then lacks those keys, which nothing in it can observe: the only
 * readers were the lines removed. Measured at gzip 9 on the tailnet-door
 * branch: 40,996 before, 40,522 after.
 *
 * Two guards keep that true, and both fail the build rather than warn:
 *
 * 1. `stripUnreadFields` THROWS when a statement it cuts is not in the source
 *    as written. A reshaped reader must be looked at, not silently shipped
 *    whole or half-cut.
 * 2. `assertReadsNoStrippedField` refuses a bundle that reads one of the
 *    fields. A widget change that starts showing, say, a thread's summary
 *    would otherwise get `undefined` from a reader the build had emptied, with
 *    nothing red anywhere. The remedy it names is to drop that field's cut.
 */

/** One source file's cuts: exact statements, and blocks named by their opening line. */
interface ReaderCut {
  /** Path suffix of the module, forward slashes. */
  readonly file: string;
  /** Removed exactly as written, once each. */
  readonly lines: readonly string[];
  /** An opening line; the block runs to the first `}` line at the same indent. */
  readonly blocks: readonly string[];
}

export const READER_CUTS: readonly ReaderCut[] = [
  {
    file: 'core/src/schema.ts',
    lines: [
      "  const summary = readStoredSummary(threadMap.get('summary'));\n",
      '    ...(summary ? { summary } : {}),\n',
      "        const edits = readCommentEdits(c.get('edits'));\n",
      '          ...(edits ? { edits } : {}),\n',
      "        const via = readWriteVia(c.get('via'));\n",
      '          ...(via ? { via } : {}),\n',
      "  const statusVia = readWriteVia(threadMap.get('statusVia'));\n",
      '    ...(statusVia ? { statusVia } : {}),\n',
      // Two DERIVED fields rather than two lifts, and cut for the same
      // reason: the widget draws a pin, a row, a popover and the dock, and
      // reads neither the count nor the clock. `createdAt` stays — the
      // reader's own guard reads it.
      '  const lastActivity =\n' +
        '    comments.length > 0 ? (comments[comments.length - 1]?.ts ?? createdAt) : createdAt;\n',
      '    commentCount: comments.length,\n',
      '    lastActivity,\n',
    ],
    blocks: [],
  },
  {
    file: 'core/src/review-item-wire.ts',
    lines: [
      // The judge's HOLD REASONS. The widget reads one thing off a verdict —
      // whether the item is gated, which `isReviewPayloadGated` answers from
      // `verdict` alone — so the list of what the judge held it for is read
      // by nobody in this bundle. `reason` and `add` stay: their names are
      // too common to guard a bundle against reading (`classList.add`), and
      // an unguarded cut is the one that ships `undefined` to a new reader.
      '  const heldFor = Array.isArray(value.heldFor)\n' +
        "    ? value.heldFor.filter((r): r is string => typeof r === 'string')\n" +
        '    : [];\n',
      '    ...(heldFor.length > 0 ? { heldFor } : {}),\n',
      "  if (typeof value.answeredBy === 'string') out.answeredBy = value.answeredBy;\n",
      "  if (typeof value.withdrawnBy === 'string') out.withdrawnBy = value.withdrawnBy;\n",
      "  if (typeof value.withdrawnReason === 'string') out.withdrawnReason = value.withdrawnReason;\n",
      '    const span = readSpan(raw.revisedRange);\n',
      '    if (span) rev.revisedRange = span;\n',
      '  const payloadPartial = readPartialAnswers(value.partialAnswers);\n',
      '  if (payloadPartial) out.partialAnswers = payloadPartial;\n',
    ],
    blocks: ['  if (Array.isArray(value.answerHistory)) {\n'],
  },
];

/** The fields those cuts stop lifting, which the bundle must therefore never read. */
export const STRIPPED_FIELDS: readonly string[] = [
  'summary',
  'edits',
  'via',
  'statusVia',
  'commentCount',
  'lastActivity',
  'heldFor',
  'answeredBy',
  'withdrawnBy',
  'withdrawnReason',
  'revisedRange',
  'answerHistory',
  'partialAnswers',
];

/** The cut for a module path, or undefined when the file is not one of the readers. */
export function readerCutFor(path: string): ReaderCut | undefined {
  const normalized = path.replaceAll('\\', '/');
  return READER_CUTS.find((cut) => normalized.endsWith(`/${cut.file}`));
}

/**
 * `source` with the cut's statements and blocks removed. THROWS naming the
 * first one it cannot find, with `where` naming the file.
 *
 * A line that appears TWICE throws as well, because `String.replace` with a
 * string pattern removes only the first — a duplicated statement would strip
 * less than the cut says it does, ship a reader that still lifts the field,
 * and say nothing. Throwing turns that into a build failure on the change
 * that causes it, which is the guarantee the rest of this file rests on.
 */
export function stripUnreadFields(source: string, cut: ReaderCut, where: string): string {
  const missing = (what: string) =>
    new Error(
      `widget-unread-fields: ${where} no longer contains ${JSON.stringify(what)}. ` +
        'Fix the cut in packages/widget/scripts/strip-unread-fields.ts to match the reader.',
    );
  const duplicated = (what: string, count: number) =>
    new Error(
      `widget-unread-fields: ${where} contains ${JSON.stringify(what)} ${count} times; ` +
        'a cut removes one occurrence only. Give the cut a longer, unique line.',
    );
  let out = source;
  for (const line of cut.lines) {
    const count = out.split(line).length - 1;
    if (count === 0) throw missing(line);
    if (count > 1) throw duplicated(line, count);
    out = out.replace(line, '');
  }
  for (const opening of cut.blocks) {
    const start = out.indexOf(opening);
    if (start === -1) throw missing(opening);
    const indent = opening.slice(0, opening.length - opening.trimStart().length);
    const close = `\n${indent}}\n`;
    const end = out.indexOf(close, start);
    if (end === -1) throw missing(`${opening}…${close}`);
    out = out.slice(0, start) + out.slice(end + close.length);
  }
  return out;
}

/**
 * Throw when the minified `bundle` reads a stripped field: `.name`, `{name:` or
 * `,name:` (an object literal or a destructure, as the minifier writes them) or
 * a quoted `'name'`. Markup and CSS that merely contain the word — `<summary>`,
 * `.vnote summary::-webkit-details-marker` — are none of those, so they pass.
 */
export function assertReadsNoStrippedField(
  bundle: string,
  name: string,
  fields: readonly string[] = STRIPPED_FIELDS,
): void {
  const read = fields.filter((field) =>
    new RegExp(`\\.${field}\\b|[{,]${field}:(?!:)|["'\`]${field}["'\`]`).test(bundle),
  );
  if (read.length === 0) return;
  throw new Error(
    `widget-unread-fields: ${name} reads ${read.join(', ')}, which the build strips from ` +
      "the widget's thread reader. Remove that field's cut from " +
      'packages/widget/scripts/strip-unread-fields.ts, or the widget reads undefined.',
  );
}
