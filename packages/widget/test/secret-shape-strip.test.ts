import { describe, expect, it } from 'vitest';
import { stripSecretShape } from '../scripts/strip-secret-shape.ts';

/**
 * The widget's bundle must not carry the SECRET shape's reader: it has no form
 * for that ask, and the values it asks for are typed on the board. The build
 * removes the two guarded lines from its copy of the reader, and the only
 * thing standing between "removed" and "silently back in every embed" is that
 * this rewrite fails loudly when it cannot find what it came for.
 */
describe('taking the secret shape out of the widget copy of the reader', () => {
  const reader = [
    'export function normalizeReviewType(value) {',
    "  if (value === 'decision') return 'decision';",
    "  if (READS_SECRET_SHAPE && value === 'secret') return 'secret';",
    '  return undefined;',
    '}',
    'function readReviewPayload(value) {',
    '  const out = {};',
    '  if (READS_SECRET_SHAPE) applySecretShape(out, shape, value);',
    '  return out;',
    '}',
    '',
  ].join('\n');

  it('drops both guarded lines and leaves the rest of the reader alone', () => {
    const out = stripSecretShape(reader, 'reader.ts');
    expect(out).not.toContain('READS_SECRET_SHAPE');
    expect(out).not.toContain('applySecretShape');
    // The shapes a widget DOES render are untouched — a rewrite that took the
    // reader's other answers with it would break every ask on every host page.
    expect(out).toContain("if (value === 'decision') return 'decision';");
    expect(out).toContain('const out = {};');
  });

  it('refuses a reader it cannot find the line in, naming the line', () => {
    const renamed = reader.replace(
      'applySecretShape(out, shape, value)',
      'applySecret(out, value)',
    );
    expect(() => stripSecretShape(renamed, 'reader.ts')).toThrow(/applySecretShape/);
    // Control: the SAME rewrite over the same reader unrenamed does not throw,
    // so the refusal above is the missing line and not a rewrite that always
    // throws.
    expect(() => stripSecretShape(reader, 'reader.ts')).not.toThrow();
  });
});
