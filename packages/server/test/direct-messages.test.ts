/**
 * The direct-message log: both people read one conversation, in order, from
 * a mode-600 file in its own folder, apart from the private-message logs.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDirectMessageStore } from '../src/direct-messages.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'cw-direct-messages-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

let clock = 1_000;
const now = () => clock++;
const alice = { id: 'user-alice', name: 'Alice' };
const bob = { id: 'user-bob', name: 'Bob' };

describe('FileDirectMessageStore', () => {
  it('gives both people the same conversation, oldest first, each line naming who it is to', () => {
    const store = new FileDirectMessageStore(dataDir, now);
    store.append(alice, bob.id, 'one');
    store.append(bob, alice.id, 'two');
    store.append(alice, bob.id, 'three');

    const reloaded = new FileDirectMessageStore(dataDir, now);
    const fromAlice = reloaded.page(alice.id, bob.id);
    const fromBob = reloaded.page(bob.id, alice.id);
    expect(fromAlice).toEqual(fromBob);
    expect(fromAlice.messages.map((m) => [m.author.name, m.to, m.text])).toEqual([
      ['Alice', bob.id, 'one'],
      ['Bob', alice.id, 'two'],
      ['Alice', bob.id, 'three'],
    ]);
    const last = reloaded.page(alice.id, bob.id, { limit: 2 });
    expect(last.messages.map((m) => m.text)).toEqual(['two', 'three']);
    expect(last.more).toBe(true);
    // A third person reads nothing of it.
    expect(reloaded.page(alice.id, 'user-saltmarsh').messages).toEqual([]);
  });

  it('keeps its logs mode 600 in their own folder, and refuses a pair of one', () => {
    const store = new FileDirectMessageStore(dataDir, now);
    store.append(alice, '../../escape', 'x');
    const dir = join(dataDir, 'direct-messages');
    for (const f of readdirSync(dir)) {
      expect(f).not.toContain('/');
      expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(dataDir)).not.toContain('private-messages');
    expect(() => store.append(alice, alice.id, 'to myself')).toThrow();
  });
});
