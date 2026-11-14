import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { listThreadsWithLinks } from './linked-item.ts';
import { createThread, getThreads, setStatus } from './schema.ts';
import { readThreadProgress, setThreadProgress } from './thread-progress.ts';
import type { User } from './types.ts';

const alice: User = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#cb4d56' };
const agent = {
  id: 'agent-harborlight',
  name: 'Harborlight site',
  kind: 'agent',
} as unknown as User;

function docWithThread(): Y.Doc {
  const doc = new Y.Doc();
  createThread(doc, {
    threadId: 't1',
    anchor: { kind: 'subject' } as never,
    createdBy: alice,
    firstComment: { id: 'c1', text: 'Riverbend opens at nine, should say 9:00' },
  });
  return doc;
}

describe('thread progress', () => {
  it('an agent marks a thread working, then done, and the thread stays open', () => {
    const doc = docWithThread();
    expect(setThreadProgress(doc, 't1', 'working', agent, 1000)).toBe(true);
    let t = listThreadsWithLinks(doc)[0];
    expect(t?.progress).toEqual({ state: 'working', by: agent, at: 1000 });
    expect(t?.status).toBe('open');
    setThreadProgress(doc, 't1', 'done', agent, 2000);
    t = listThreadsWithLinks(doc)[0];
    expect(t?.progress).toEqual({ state: 'done', by: agent, at: 2000 });
    expect(t?.status).toBe('open');
  });

  it('open clears the mark', () => {
    const doc = docWithThread();
    setThreadProgress(doc, 't1', 'done', agent, 1);
    setThreadProgress(doc, 't1', 'open', agent, 2);
    expect(listThreadsWithLinks(doc)[0]?.progress).toBeUndefined();
  });

  it('a status change clears the mark, so a reopened thread is not still done', () => {
    const doc = docWithThread();
    setThreadProgress(doc, 't1', 'done', agent, 1);
    setStatus(doc, 't1', 'resolved');
    setStatus(doc, 't1', 'open');
    expect(listThreadsWithLinks(doc)[0]?.progress).toBeUndefined();
  });

  it('refuses a thread that does not exist', () => {
    const doc = docWithThread();
    expect(setThreadProgress(doc, 'nope', 'done', agent, 1)).toBe(false);
  });

  it('reads a malformed stored mark as no mark', () => {
    expect(readThreadProgress(undefined)).toBeUndefined();
    expect(readThreadProgress({ state: 'finished', by: agent, at: 1 })).toBeUndefined();
    expect(readThreadProgress({ state: 'done', by: 'x', at: 1 })).toBeUndefined();
    expect(readThreadProgress({ state: 'done', by: agent, at: 'soon' })).toBeUndefined();
    expect(readThreadProgress({ state: 'done', by: { id: 'a' }, at: 1 })).toBeUndefined();
  });

  it('syncs to another replica', () => {
    const a = docWithThread();
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    setThreadProgress(a, 't1', 'working', agent, 5);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readThreadProgress(getThreads(b).get('t1')?.get('progress'))?.state).toBe('working');
  });
});
