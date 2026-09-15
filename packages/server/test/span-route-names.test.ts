/**
 * Every route this server answers arrives at Sentry under a name of its own.
 *
 * `routePatternForSpan` names a path by matching it against ROUTE_TEMPLATES,
 * and a path that matches nothing degrades to every segment becoming `:id`.
 * That is safe — it is the whole point of the degrade — but it is not a name:
 * unrelated routes land under one description, and Sentry's N+1 detector reads
 * "the same call, twice". That is what put board Home, the board page and the
 * doc page in ONE browser N+1 group: `/api/calendar/events` and
 * `/workspaces/<ws>/links:titles` both read as `/:id/:id/:id`, and on the doc
 * page `…/meeting-bot` and `…/notes-method` both read as
 * `/:id/:id/:id/:id/:id` — a page making two different calls, filed as a
 * repeat. 106 of 271 rows were unnamed when this was written.
 *
 * The table cannot be checked against itself, so it is checked against the
 * server's own written-down set of addresses: ROUTE_TABLE, whose `example` is
 * a real path derived from the pattern.
 */
import { describe, expect, it } from 'bun:test';
import { routePatternForSpan } from '@claude-workspaces/core/trace-privacy';
import { ROUTE_TABLE } from '../src/routes/route-table-rows.ts';

/** A name that says nothing: `/:id`, `/:id/:id`, and so on. */
const isUnnamed = (name: string): boolean => /^\/(:id)(\/:id)*$/.test(name);

describe('span names for every route', () => {
  it('names every fixed-length route in ROUTE_TABLE', () => {
    const unnamed = ROUTE_TABLE.filter(
      (r) => !r.pattern.includes('*') && isUnnamed(routePatternForSpan(r.example)),
    ).map((r) => r.pattern);
    // Listed, not counted: the failure has to say which route to add.
    expect(unnamed).toEqual([]);
  });

  it('degrades an address no route claims to all-:id rather than guessing', () => {
    // The property the gate above must not have been bought by weakening:
    // a segment is literal only where a REAL route puts a literal.
    expect(routePatternForSpan('/workspaces/w-1/not-a-route')).toBe('/:id/:id/:id');
    expect(routePatternForSpan('/nonsense/content/content')).toBe('/:id/:id/:id');
  });

  it('prefers the more specific of two routes that both claim an address', () => {
    // `…/tasks/batch` and `…/tasks/:id` both match; the literal one wins, so
    // a real route keyword is not hidden behind an id-shaped sibling.
    expect(routePatternForSpan('/workspaces/w-1/tasks/batch')).toBe('/workspaces/:id/tasks/batch');
    expect(routePatternForSpan('/workspaces/w-1/tasks/t-1')).toBe('/workspaces/:id/tasks/:id');
    expect(routePatternForSpan('/recall/status')).toBe('/recall/status');
    expect(routePatternForSpan('/recall/0123456789abcdef')).toBe('/recall/:id');
  });

  it('keeps a caller-chosen id out of the name even when it spells a route word', () => {
    // The case the whole-template match exists for: a doc titled "content"
    // sitting at `…/docs/content/content`. The id position stays `:id`.
    expect(routePatternForSpan('/workspaces/w-1/docs/content/content')).toBe(
      '/workspaces/:id/docs/:id/content',
    );
  });

  it('names the three calls this gate was written for', () => {
    expect(routePatternForSpan('/api/calendar/events')).toBe('/api/calendar/events');
    expect(routePatternForSpan('/workspaces/w-1/links:titles')).toBe(
      '/workspaces/:id/links:titles',
    );
    expect(routePatternForSpan('/workspaces/w-1/docs/d-1/meeting-bot')).toBe(
      '/workspaces/:id/docs/:id/meeting-bot',
    );
    expect(routePatternForSpan('/workspaces/w-1/docs/d-1/notes-method')).toBe(
      '/workspaces/:id/docs/:id/notes-method',
    );
  });
});
