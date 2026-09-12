/**
 * Everything about the SECRET shape that a reader of a stored payload needs —
 * and the one module the widget's bundle does not carry.
 *
 * It is a file of its own for a size reason that turned out to be a security
 * reason too. `readReviewPayload` is reached from `schema.ts`, so every
 * surface that reads a thread pulls this in, and the widget is one of them: it
 * is injected into other people's pages under a hard gzip budget, and the
 * whole of this shape's reading cost it 103 gzipped bytes against a ceiling it
 * had twenty to spare against.
 *
 * The widget swaps this module for a stand-in that answers "no" to all three
 * (`packages/widget/scripts/shims/core-secret-wire.js`, checked export by
 * export at build time by `assertShimCovers`). What that does to a widget
 * holding a stored secret payload is the part worth reading: `isSecretShape`
 * answers false, so `normalizeReviewType` returns undefined, so
 * `readReviewPayload` returns UNDEFINED — the payload is not read at all. The
 * comment stays an ordinary comment and the dock never sees an ask. There is
 * no state in which the widget renders a secret ask with its owner-only flag
 * missing, because there is no state in which it renders one.
 *
 * That is the only divergence the swap can produce, and it is the safe
 * direction. Everywhere else — the server, the board, the MCP bundle — reads
 * the real thing.
 */
import type { ReviewPayload, ReviewSecretField, ReviewShape } from './review-item-types.ts';

/**
 * The alphabet a stored-secret name may use, and the one place it is written.
 *
 * Narrow because the name is INTERPOLATED INTO A COMMAND'S ARGUMENT LIST by
 * the writer that stores the value. A name holding a space would split into
 * two arguments, and the length ceiling keeps a pasted document out of an
 * argv slot.
 *
 * THE FIRST CHARACTER IS NARROWER THAN THE REST, and that is the half worth
 * reading twice. `-` is a legal character inside a name (`riverbend-weather-
 * key` is the shape every real one has) and an unacceptable one to START
 * with: the writer's command is `security add-generic-password … -s <name>`,
 * and a name of `-w` would be consumed as that command's own password flag
 * rather than as the value of `-s`. The first version of this predicate
 * allowed it, and the test that names the case is what found it.
 *
 * Shared by the gate that admits an item (`checkReviewPayload`) and the
 * module that runs the command, so the name the card showed and the name the
 * store accepts cannot be two different sets.
 */
export function isSecretServiceName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(value);
}

/**
 * The asked-for fields, read back defensively — label and service only.
 *
 * There is no value to read: a stored payload has never held one, on any
 * path. A row missing either half is dropped rather than rendered half-built,
 * because a field with no service has nowhere to store what the reader types
 * and a field with no label asks for nothing.
 */
export function readSecretFields(value: unknown): ReviewSecretField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ReviewSecretField[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.label !== 'string' || row.label.trim() === '') continue;
    // Read through the same predicate the gate uses. A stored name that
    // would not be admitted today is dropped rather than handed to a writer.
    if (!isSecretServiceName(row.service)) continue;
    out.push({ label: row.label, service: row.service });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The whole of what reading a stored payload adds when the shape is a secret
 * ask: the fields asked for, and the owner-only flag.
 *
 * ONE call site, because one call site is one thing for the widget's stand-in
 * to answer for. The flag is FORCED rather than read — `readReviewPayload` is
 * the write path's normalizer AND every read path's reader, so setting it
 * here means a secret item is owner-only when it is stored, when it is read
 * back, and when it is read back out of a `.ydoc` written before this line
 * existed. The server's refusal reads that flag, so a payload that could
 * arrive without it is an ask a Regular User could answer.
 */
export function applySecretShape(
  out: ReviewPayload,
  shape: ReviewShape | undefined,
  value: Record<string, unknown>,
): void {
  if (shape !== 'secret') return;
  const secrets = readSecretFields(value.secrets);
  if (secrets) out.secrets = secrets;
  out.ownerOnly = true;
}
