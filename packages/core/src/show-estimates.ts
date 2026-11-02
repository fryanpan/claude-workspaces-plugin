/**
 * "Show estimates": whether a board shows its effort estimates to the people
 * reading it (Bryan, 1 Nov: "Let's add a setting to hide all the
 * estimations … default to having the setting off on all boards and hide all
 * estimation stuff on all screens behind that setting").
 *
 * OFF unless the board says `true`. A board that never set it, a record from
 * before the setting existed and a malformed value all read as off, so no
 * board shows an estimate by accident.
 *
 * Only what a person SEES. The scorer keeps scoring every ticket and agents
 * still read the numbers, so turning the setting on shows current estimates
 * rather than starting from nothing.
 *
 * In `core` because the server stores and validates it and the board page
 * reads it off the board doc, and both must agree on what "off" is.
 */

/** Whether a board record, or the board doc's `workspace` map read into one,
 *  shows estimates. */
export function estimatesShown(record: { showEstimates?: unknown } | null | undefined): boolean {
  return record?.showEstimates === true;
}

/** A settings write's `showEstimates` field: `true` or `false`, or `null` for
 *  the default, which is off. */
export function parseShowEstimates(
  raw: unknown,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: false };
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  return { ok: false, error: 'showEstimates must be true or false, or null for the default (off)' };
}
