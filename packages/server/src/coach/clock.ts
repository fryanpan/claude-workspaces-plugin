/**
 * The coach's calendar: which local day an instant falls on in the owner's time
 * zone. Pure, so the tests drive it with fixed instants.
 */
import { zonedParts } from '@claude-workspaces/core/schedule-timezone';

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` for the local day `instant` falls on. */
export function localDay(instant: number, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
