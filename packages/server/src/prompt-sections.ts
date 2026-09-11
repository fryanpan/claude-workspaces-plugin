/**
 * A markdown prompt, cut and spliced by its `###` HEADINGS.
 *
 * Every prompt this server sends is markdown with `###` sections, and some
 * callers change a prompt before it goes out: a solo meeting drops the rules
 * about who spoke, and a ledger method swaps the grouping rule for its own.
 * Both used to find their text by an exact sentence, so a person rewording
 * that sentence on the settings page silently turned the change off.
 *
 * A heading is the one part of a section that rewording its body cannot
 * move. So a section here is a `###` heading line and every line after it, up
 * to the next heading of level 1 to 3 or the end of the prompt. The heading
 * text matches case-insensitively and with the space around it ignored.
 * Lines inside a fenced code block are never read as headings — a prompt's
 * example output can hold a `###` line.
 */

/** One section's place in the lines: `[start, end)`, heading included. */
interface Span {
  start: number;
  end: number;
}

const HEADING = /^(#{1,3})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

function norm(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Every section headed `### <heading>`, first to last. */
function spans(lines: readonly string[], heading: string): Span[] {
  const want = norm(heading);
  const out: Span[] = [];
  let fenced = false;
  let open: number | null = null;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const m = HEADING.exec(line);
    if (!m) return;
    if (open !== null) {
      out.push({ start: open, end: i });
      open = null;
    }
    if (m[1] === '###' && norm(m[2] ?? '') === want) open = i;
  });
  if (open !== null) out.push({ start: open, end: lines.length });
  return out;
}

/** Drop blank lines from the end of a block, so a cut leaves no gap behind. */
function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--;
  return lines.slice(0, end);
}

/** True when the prompt has a `### <heading>` section. */
export function hasSection(markdown: string, heading: string): boolean {
  return spans(markdown.split('\n'), heading).length > 0;
}

/**
 * The prompt with every `### <heading>` section taken out, heading and body.
 * Unchanged when there is none.
 */
export function withoutSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const found = spans(lines, heading);
  if (found.length === 0) return markdown;
  const cut = new Set<number>();
  for (const s of found) for (let i = s.start; i < s.end; i++) cut.add(i);
  const kept = lines.filter((_, i) => !cut.has(i));
  return trimTrailingBlank(kept).join('\n');
}

/**
 * The prompt with the FIRST `### <heading>` section replaced by
 * `replacement`, or null when there is no such section — the caller decides
 * what a missing section means, because "nothing to replace" is a fault for
 * one caller and ordinary for another.
 *
 * A section that ran up to another heading keeps one blank line before it.
 */
export function replaceSection(
  markdown: string,
  heading: string,
  replacement: string,
): string | null {
  const lines = markdown.split('\n');
  const first = spans(lines, heading)[0];
  if (!first) return null;
  const before = lines.slice(0, first.start);
  const after = lines.slice(first.end);
  const middle = replacement.split('\n');
  return [...before, ...middle, ...(after.length > 0 ? ['', ...after] : [])].join('\n');
}

/**
 * The prompt with `add` put at the end of the FIRST `### <heading>`
 * section, after its last non-blank line. Null when there is no such
 * section.
 */
export function appendToSection(markdown: string, heading: string, add: string): string | null {
  const lines = markdown.split('\n');
  const first = spans(lines, heading)[0];
  if (!first) return null;
  const body = trimTrailingBlank(lines.slice(first.start, first.end));
  const after = lines.slice(first.end);
  return [
    ...lines.slice(0, first.start),
    ...body,
    ...add.split('\n'),
    ...(after.length > 0 ? ['', ...after] : []),
  ].join('\n');
}
