/**
 * The board rules a session reads at launch, cut out of the
 * `working-in-a-workspace` skill.
 *
 * One copy, two deliveries. The rules live in the skill, folded into the
 * section about their topic, and each sits between a `<!-- session-start -->`
 * and a `<!-- /session-start -->` marker. The SessionStart hook sends only the
 * marked regions. A session gets them before its first turn, and it does not
 * have to open the skill. The skill keeps the whole text for a session that does.
 *
 * Why the hook and not the MCP instructions: the instructions reach the system
 * prompt but are cut at about 4,096 characters, and they were already 6,441.
 * Claude Code caps a hook's `additionalContext` at 10,000 characters per field.
 * Past that, it puts a 2,000-character preview in its place. The cap is
 * `ADDITIONAL_CONTEXT_CAP` below, and a test holds the output under it.
 */

export const OPEN_MARKER = '<!-- session-start -->';
export const CLOSE_MARKER = '<!-- /session-start -->';

/** Claude Code's limit on one hook output field, in characters. */
export const ADDITIONAL_CONTEXT_CAP = 10_000;

const HEADER =
  '[claude-workspaces] Rules for work on a board. They come from the ' +
  '`claude-workspaces:working-in-a-workspace` skill. Read that skill before your first task.';

/**
 * The marked regions of `skill`, in file order, markers removed.
 *
 * Throws on a marker with no partner: a region that silently ran to the end of
 * the file, or dropped out, is the failure this module exists to prevent.
 */
export function extractRegions(skill: string): string[] {
  const regions: string[] = [];
  let at = 0;
  for (;;) {
    const open = skill.indexOf(OPEN_MARKER, at);
    const strayClose = skill.indexOf(CLOSE_MARKER, at);
    if (open === -1) {
      if (strayClose !== -1) throw new Error('board rules: a close marker has no open marker');
      return regions;
    }
    if (strayClose !== -1 && strayClose < open) {
      throw new Error('board rules: a close marker has no open marker');
    }
    const close = skill.indexOf(CLOSE_MARKER, open + OPEN_MARKER.length);
    if (close === -1) throw new Error('board rules: an open marker has no close marker');
    const nested = skill.indexOf(OPEN_MARKER, open + OPEN_MARKER.length);
    if (nested !== -1 && nested < close)
      throw new Error('board rules: an open marker is inside a region');
    regions.push(skill.slice(open + OPEN_MARKER.length, close).trim());
    at = close + CLOSE_MARKER.length;
  }
}

/** The text the hook sends, or `undefined` when the skill marks nothing. */
export function boardRulesText(skill: string): string | undefined {
  const regions = extractRegions(skill);
  if (regions.length === 0) return undefined;
  return [HEADER, ...regions].join('\n\n');
}
