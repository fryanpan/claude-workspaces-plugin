/**
 * Where a board's documents really live, by type: each rule of
 * `library-location.ts` read off hand-built input, one case per rule so a
 * broken rule names itself. The same rules over the real route and a real
 * repo are in `library-location-routes.test.ts`.
 *
 * All fixtures synthetic.
 */
import { describe, expect, it } from 'bun:test';
import {
  type PlacedDoc,
  type PlacingContext,
  STORED_BY_WORKSPACES,
  buildWhere,
  placeOf,
} from '../src/library-location.ts';

const REPO = 'git:example.com/harborlight/harborlight';
const OTHER = 'git:example.com/harborlight/saltmarsh';
const ROOT = '/box/dev/harborlight';
const DATA = '/box/data';

function ctx(over: Partial<PlacingContext> = {}): PlacingContext {
  return {
    storageRoots: [DATA, '/private/box/data'],
    projectRepoKey: REPO,
    projectVisible: true,
    meetingsFolder: 'docs/meetings',
    mountFolders: ['docs', 'docs/meetings'],
    projectNameOf: (key) => (key === OTHER ? 'saltmarsh' : null),
    ...over,
  };
}

/** A doc bound to a file of the project. */
const inRepo = (kind: PlacedDoc['kind'], relPath: string, extra: Partial<PlacedDoc> = {}) => ({
  kind,
  sourceUrl: `${ROOT}/${relPath}`,
  repoKey: REPO,
  relPath,
  fileMissing: false,
  ...extra,
});

const shape = (p: ReturnType<typeof placeOf>) => [p.label, p.note ?? null, p.stray];

describe('where a doc lives', () => {
  it('reads a doc with no file, or a file in server storage, as Stored by Workspaces', () => {
    const noFile: PlacedDoc = { kind: 'documents', fileMissing: false };
    const huddle: PlacedDoc = {
      kind: 'meetings',
      sourceUrl: '/private/box/data/huddles/h-1.md',
      fileMissing: false,
    };
    // Storage is a phrase and never a path, and it is not where the project
    // said meetings go — so a meetings folder makes it a stray.
    expect(shape(placeOf(huddle, ctx()))).toEqual([
      STORED_BY_WORKSPACES,
      'not in docs/meetings',
      true,
    ]);
    expect(shape(placeOf(noFile, ctx()))).toEqual([STORED_BY_WORKSPACES, 'not mounted', true]);
    // Nothing named, nothing to be outside of.
    expect(shape(placeOf(huddle, ctx({ meetingsFolder: undefined })))).toEqual([
      STORED_BY_WORKSPACES,
      null,
      false,
    ]);
  });

  it('reads a mockup from storage unless its source is part of the project, and never flags it', () => {
    const scratch: PlacedDoc = { kind: 'mockups', sourceUrl: '/box/tmp/m.html', fileMissing: true };
    expect(shape(placeOf(scratch, ctx()))).toEqual([STORED_BY_WORKSPACES, null, false]);
    const captured: PlacedDoc = { kind: 'mockups', fileMissing: false };
    expect(shape(placeOf(captured, ctx()))).toEqual([STORED_BY_WORKSPACES, null, false]);
    expect(shape(placeOf(inRepo('mockups', 'design/booking.html'), ctx()))).toEqual([
      'design',
      null,
      false,
    ]);
  });

  it('names the deepest configured folder a project doc sits in', () => {
    const p = placeOf(inRepo('meetings', 'docs/meetings/2026-09-12.md'), ctx());
    expect([p.label, p.folder, p.stray]).toEqual(['docs/meetings', true, false]);
    // A document under `docs/sub` is in the `docs` mount.
    expect(shape(placeOf(inRepo('documents', 'docs/sub/ferry.md'), ctx()))).toEqual([
      'docs',
      null,
      false,
    ]);
    // Mounted twice over, it is in the nearer one.
    const nested = ctx({ mountFolders: ['docs', 'docs/design'] });
    expect(shape(placeOf(inRepo('documents', 'docs/design/booking.md'), nested))).toEqual([
      'docs/design',
      null,
      false,
    ]);
  });

  it('does not count the meetings folder as where documents go', () => {
    // Mounted, but it is the meetings folder: a document there is a stray.
    const only = ctx({ mountFolders: ['docs/meetings', 'notes'] });
    expect(shape(placeOf(inRepo('documents', 'docs/meetings/plan.md'), only))).toEqual([
      'docs/meetings',
      'not mounted',
      true,
    ]);
  });

  it('flags a project doc outside every configured folder, by its real folder', () => {
    expect(shape(placeOf(inRepo('documents', 'notes/dock-survey.md'), ctx()))).toEqual([
      'notes',
      'not mounted',
      true,
    ]);
    expect(shape(placeOf(inRepo('meetings', 'notes/kickoff.md'), ctx()))).toEqual([
      'notes',
      'not in docs/meetings',
      true,
    ]);
    expect(shape(placeOf(inRepo('documents', 'README.md'), ctx()))).toEqual([
      'Project root',
      'not mounted',
      true,
    ]);
  });

  it('shows the real folder with no flag when the project names no folder', () => {
    const unset = ctx({ meetingsFolder: undefined, mountFolders: [] });
    expect(shape(placeOf(inRepo('documents', 'plans/trail-map.md'), unset))).toEqual([
      'plans',
      null,
      false,
    ]);
  });

  it('names no folder of a project hidden from this caller', () => {
    const hidden = ctx({ projectVisible: false });
    expect(shape(placeOf(inRepo('documents', 'notes/dock-survey.md'), hidden))).toEqual([
      'In the project',
      null,
      false,
    ]);
  });

  it('names another project when it may, and reads anything else as outside', () => {
    const other: PlacedDoc = {
      kind: 'documents',
      sourceUrl: '/box/dev/saltmarsh/a.md',
      repoKey: OTHER,
      relPath: 'a.md',
      fileMissing: false,
    };
    expect(shape(placeOf(other, ctx()))).toEqual(['In saltmarsh', 'not mounted', true]);
    expect(placeOf({ ...other, repoKey: 'git:example.com/x/y' }, ctx()).label).toBe(
      'In another project',
    );
    const loose: PlacedDoc = { kind: 'documents', sourceUrl: '/box/notes.md', fileMissing: false };
    expect(placeOf(loose, ctx()).label).toBe('Outside the project');
  });

  it('says a bound file has gone, where it was expected', () => {
    expect(
      shape(placeOf(inRepo('documents', 'docs/ferry.md', { fileMissing: true }), ctx())),
    ).toEqual(['docs', 'file missing', true]);
  });
});

describe('buildWhere', () => {
  it('lists all three kinds, belonging before flagged, and keys each doc to its place', () => {
    // `archive` sorts before `docs` by name, and still comes after it.
    const docs: PlacedDoc[] = [
      inRepo('documents', 'archive/dock-survey.md'),
      inRepo('documents', 'docs/ferry.md'),
      inRepo('documents', 'docs/booking.md'),
      inRepo('meetings', 'docs/meetings/walkthrough.md'),
    ];
    const { where, keys } = buildWhere(docs, ctx());
    expect(where.map((w) => [w.kind, w.places.map((p) => p.label), w.unset])).toEqual([
      ['meetings', ['docs/meetings'], false],
      ['documents', ['docs', 'archive'], false],
      // No mockup on the board: still a row, and never "no folder named".
      ['mockups', [], false],
    ]);
    expect(keys[1]).toBe(keys[2]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(where[1]?.places.map((p) => p.key)).toEqual([keys[1], keys[0]]);
  });

  it('marks a kind the project names no folder for as unset, never blank', () => {
    const { where } = buildWhere([], ctx({ meetingsFolder: undefined, mountFolders: [] }));
    expect(where.map((w) => [w.kind, w.unset])).toEqual([
      ['meetings', true],
      ['documents', true],
      ['mockups', false],
    ]);
    // A board in no repo at all has named nothing either.
    expect(buildWhere([], ctx({ projectRepoKey: null })).where[0]?.unset).toBe(true);
    // Hidden from this caller: nothing is said about its folders.
    expect(buildWhere([], ctx({ projectVisible: false })).where[0]?.unset).toBe(false);
  });
});
