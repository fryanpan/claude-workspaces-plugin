/**
 * The Recently Viewed rules over plain state: who counts as a person, the
 * order a list keeps, and when the open Library is told.
 *
 * All fixtures synthetic.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import {
  MAX_VIEWS_PER_PERSON,
  type ViewState,
  personKeyOf,
  recordView,
  viewsFor,
} from '../src/library-views.ts';
import { TaskStore } from '../src/tasks.ts';

const user = (u: Record<string, unknown>) => u as unknown as User;

describe('library views', () => {
  const dirs: string[] = [];
  const stores: TaskStore[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('keys a view to a person, never to an agent or an anonymous reader', () => {
    expect(personKeyOf(user({ id: 'known-alice', name: 'Alice', kind: 'known' }))).toBe(
      'known-alice',
    );
    expect(personKeyOf(user({ id: 'agent-lead', name: 'Lead', kind: 'agent' }))).toBeNull();
    expect(personKeyOf(user({ id: 'anon-1', name: 'Guest', kind: 'anon' }))).toBeNull();
    expect(personKeyOf(undefined)).toBeNull();
  });

  it('keeps the newest view first, one row per doc, and caps the list', () => {
    const s: ViewState = {};
    recordView(s, 'known-alice', 'd-plan', 1_000);
    recordView(s, 'known-alice', 'd-notes', 2_000);
    recordView(s, 'known-alice', 'd-plan', 3_000);
    expect(viewsFor(s, 'known-alice', () => true)).toEqual([
      { docId: 'd-plan', at: 3_000 },
      { docId: 'd-notes', at: 2_000 },
    ]);
    expect(viewsFor(s, 'known-bob', () => true)).toEqual([]);
    expect(viewsFor(s, null, () => true)).toEqual([]);
    // A doc no longer on the board drops out of the reading.
    expect(viewsFor(s, 'known-alice', (d) => d !== 'd-plan').map((v) => v.docId)).toEqual([
      'd-notes',
    ]);
    for (let i = 0; i < MAX_VIEWS_PER_PERSON + 5; i++) recordView(s, 'known-bob', `d-${i}`, i);
    expect(viewsFor(s, 'known-bob', () => true)).toHaveLength(MAX_VIEWS_PER_PERSON);
  });

  it('a reload of the top doc is only re-timed, not news', () => {
    const s: ViewState = {};
    expect(recordView(s, 'known-alice', 'd-plan', 1_000, 60_000)).toBe(true);
    expect(recordView(s, 'known-alice', 'd-plan', 2_000, 60_000)).toBe(false);
    expect(viewsFor(s, 'known-alice', () => true)[0]?.at).toBe(2_000);
    expect(recordView(s, 'known-alice', 'd-notes', 3_000, 60_000)).toBe(true);
    expect(recordView(s, 'known-alice', 'd-plan', 4_000, 60_000)).toBe(true);
  });

  it('tells the open Library when a person’s list changes', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'library-views-'));
    dirs.push(dataDir);
    const store = new TaskStore({ dataDir, debounceMs: 5 });
    stores.push(store);
    const ws = store.createWorkspace('Harborlight');
    const told: string[] = [];
    store.onBoardDocsChanged = (id) => told.push(id);
    expect(store.recordLibraryView(ws.id, 'known-alice', 'd-plan', 1_000)).toBe(true);
    expect(told).toEqual([ws.id]);
    // The same doc again straight away changes nothing a reader sees.
    store.recordLibraryView(ws.id, 'known-alice', 'd-plan', 1_000);
    expect(told).toEqual([ws.id]);
    expect(store.recordLibraryView('no-such-board', 'known-alice', 'd-plan', 1)).toBe(false);
  });
});
