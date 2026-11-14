/** A small app's presence setup, shared by the core's presence tests. */
import type { RoleFn } from '../../src/collab/index.ts';

export interface Spot {
  page: string;
  scroll: number;
}

/** Alice is on both boards, Bob only on Harborlight, Saltmarsh only on
 *  Riverbend. */
export const ROLES: RoleFn = (p, room) => {
  if (p.id === 'alice') return 'edit';
  if (p.id === 'bob') return room === 'harborlight' ? 'edit' : null;
  if (p.id === 'saltmarsh') return room === 'riverbend' ? 'view' : null;
  return null;
};

export function parseSpot(raw: unknown): Spot | null {
  const r = raw as { page?: unknown; scroll?: unknown } | null;
  if (!r || typeof r.page !== 'string' || !/^[a-z0-9/-]{1,64}$/.test(r.page)) return null;
  const scroll = typeof r.scroll === 'number' && r.scroll >= 0 && r.scroll <= 1 ? r.scroll : 0;
  return { page: r.page, scroll };
}

export const pageOf = (s: Spot): string => s.page;
