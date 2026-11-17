import { describe, expect, it } from 'vitest';
import { MemoryPrivateMessageStore, pairKey } from '../../src/collab/index.ts';

const msg = (personId: string, agentId: string, text: string) => ({
  personId,
  agentId,
  from: 'person' as const,
  author: { id: personId, name: personId },
  text,
});

describe('MemoryPrivateMessageStore', () => {
  it('keeps one log per pair, and a pair reads only its own', () => {
    const store = new MemoryPrivateMessageStore();
    store.append(msg('alice', 'harborlight', 'to harborlight'));
    store.append(msg('alice', 'riverbend', 'to riverbend'));
    store.append(msg('bob', 'harborlight', 'from bob'));
    expect(store.pairCount()).toBe(3);
    expect(store.page('alice', 'harborlight').messages.map((m) => m.text)).toEqual([
      'to harborlight',
    ]);
    expect(store.page('bob', 'harborlight').messages.map((m) => m.text)).toEqual(['from bob']);
    expect(store.page('bob', 'riverbend').messages).toEqual([]);
  });

  it('pages newest-last and walks back with before', () => {
    let n = 0;
    const store = new MemoryPrivateMessageStore(
      () => 1000,
      () => `pm-${++n}`,
    );
    for (let i = 1; i <= 5; i++) store.append(msg('alice', 'harborlight', `m${i}`));
    const first = store.page('alice', 'harborlight', { limit: 2 });
    expect(first.messages.map((m) => m.text)).toEqual(['m4', 'm5']);
    expect(first.more).toBe(true);
    const older = store.page('alice', 'harborlight', { limit: 2, before: first.messages[0]?.id });
    expect(older.messages.map((m) => m.text)).toEqual(['m2', 'm3']);
    const oldest = store.page('alice', 'harborlight', { limit: 2, before: older.messages[0]?.id });
    expect(oldest).toEqual({ messages: [expect.objectContaining({ text: 'm1' })], more: false });
  });

  it('gives ids that cannot be confused across pairs', () => {
    expect(pairKey('a~b', 'c')).not.toBe(pairKey('a', 'b~c'));
  });
});
