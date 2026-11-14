/**
 * The private-message log: one append-only file per person and agent, mode
 * 600, read back the same after a reload, and never a path outside its own
 * folder whatever the ids say.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePrivateMessageStore } from '../src/private-messages.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'cw-private-messages-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

let clock = 1_000;
const now = () => clock++;

describe('FilePrivateMessageStore', () => {
  it('reads the same log back after a reload, oldest first, and pages from the end', () => {
    const store = new FilePrivateMessageStore(dataDir, now);
    const alice = { id: 'user-alice', name: 'Alice' };
    const a1 = { id: 'agent-harborlight', name: 'Harborlight' };
    store.append({
      personId: alice.id,
      agentId: a1.id,
      from: 'person',
      author: alice,
      text: 'one',
    });
    store.append({ personId: alice.id, agentId: a1.id, from: 'agent', author: a1, text: 'two' });
    const third = store.append({
      personId: alice.id,
      agentId: a1.id,
      from: 'person',
      author: alice,
      text: 'three',
    });
    expect(third.id).toMatch(/^pm-/);

    const reloaded = new FilePrivateMessageStore(dataDir, now);
    const all = reloaded.page(alice.id, a1.id);
    expect(all.messages.map((m) => [m.from, m.text])).toEqual([
      ['person', 'one'],
      ['agent', 'two'],
      ['person', 'three'],
    ]);
    expect(all.more).toBe(false);
    const last = reloaded.page(alice.id, a1.id, { limit: 2 });
    expect(last.messages.map((m) => m.text)).toEqual(['two', 'three']);
    expect(last.more).toBe(true);
    const before = reloaded.page(alice.id, a1.id, { limit: 2, before: last.messages[0]?.id });
    expect(before.messages.map((m) => m.text)).toEqual(['one']);

    // Another pair reads nothing of this one.
    expect(reloaded.page('user-bob', a1.id).messages).toEqual([]);
    expect(reloaded.page(alice.id, 'agent-riverbend').messages).toEqual([]);
  });

  it('writes each log mode 600, inside its own folder, whatever the ids hold', () => {
    const store = new FilePrivateMessageStore(dataDir, now);
    const author = { id: 'x', name: 'x' };
    store.append({ personId: '../../escape', agentId: '..', from: 'person', author, text: 'x' });
    store.append({ personId: 'user~a', agentId: 'b', from: 'person', author, text: 'x' });
    store.append({ personId: 'user', agentId: 'a~b', from: 'person', author, text: 'y' });
    const dir = join(dataDir, 'private-messages');
    const files = readdirSync(dir);
    for (const f of files) {
      expect(f).not.toContain('/');
      expect(f.startsWith('.')).toBe(false);
      expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(dataDir)).not.toContain('escape');
    // Two pairs whose ids join to the same string stay two logs.
    expect(store.page('user~a', 'b').messages.map((m) => m.text)).toEqual(['x']);
    expect(store.page('user', 'a~b').messages.map((m) => m.text)).toEqual(['y']);
    expect(() =>
      store.append({ personId: '', agentId: 'b', from: 'person', author, text: 'x' }),
    ).toThrow();
  });
});
