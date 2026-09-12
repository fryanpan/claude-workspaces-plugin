/**
 * Take the SECRET shape's reader out of the widget's copy of the review-item
 * wire reader.
 *
 * `readReviewPayload` is reached from `schema.ts`, so every surface that reads
 * a thread pulls that reader in — the widget included, and the widget is
 * injected into other people's pages under a hard gzip budget. It has no form
 * for a secret ask and must never render one: the values are typed on the
 * board, on the machine the board runs on. Carrying the reading of a shape
 * nothing here can show is cost with no reader.
 *
 * So the two lines the reader guards with `READS_SECRET_SHAPE` come out, and
 * nothing then references the module behind them, which the bundler drops
 * whole. What that leaves is the behaviour this bundle already wants:
 * `normalizeReviewType` answers undefined for a stored secret payload,
 * `readReviewPayload` therefore returns undefined, and the comment carrying it
 * stays an ordinary comment the dock never sees as an ask. Dropping the ask is
 * the safe direction — there is no state in which this bundle renders a secret
 * ask with its owner-only flag missing, because there is no state in which it
 * renders one.
 *
 * A deletion rather than a constant the minifier folds: measured, flipping
 * `READS_SECRET_SHAPE` to `false` left both branches, the call and the module
 * they reach in the bundle, 28 bytes over budget. Bun does not propagate a
 * constant into the branch that reads it.
 */

/** The lines removed, exactly as the reader writes them. */
export const SECRET_SHAPE_LINES: readonly string[] = [
  "  if (READS_SECRET_SHAPE && value === 'secret') return 'secret';\n",
  '  if (READS_SECRET_SHAPE) applySecretShape(out, shape, value);\n',
];

/**
 * The reader's source with those lines gone.
 *
 * THROWS when either line is absent, and that is the point: a rename in the
 * reader that silently stopped matching would put the secret shape back into
 * every embed on every host page, with nothing red anywhere. `where` names the
 * file in the message so the failure says what to fix.
 */
export function stripSecretShape(source: string, where: string): string {
  let out = source;
  for (const line of SECRET_SHAPE_LINES) {
    if (!out.includes(line)) {
      throw new Error(
        `widget-no-secret-shape: ${where} no longer contains ${JSON.stringify(line)}. ` +
          "The widget would ship the secret shape's reader to every host page; fix this " +
          'rewrite, or the reader, before shipping the bundle.',
      );
    }
    out = out.replace(line, '');
  }
  return out;
}
