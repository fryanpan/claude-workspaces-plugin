/**
 * A page asks whether its socket still carries bytes (`core/src/ws-probe.ts`)
 * and gets the same byte back, on every kind of socket a page can hold, and
 * nothing happens to the doc.
 */
import { describe, expect, it } from 'bun:test';
import { MSG_PROBE } from '@claude-workspaces/core/ws-probe';
import * as Y from 'yjs';
import type { FeedbackWs, LiveDoc } from '../src/doc-store.ts';
import { onMessage } from '../src/yjs-protocol.ts';

function ask(data: Partial<FeedbackWs['data']>) {
  const ydoc = new Y.Doc();
  ydoc.getMap('threads').set('t', 'open');
  const before = Y.encodeStateAsUpdate(ydoc);
  const sent: Uint8Array[] = [];
  const ws = {
    data,
    sendBinary: (frame: Uint8Array) => sent.push(frame),
  } as unknown as FeedbackWs;
  onMessage({ docId: 'd-berths', ydoc } as unknown as LiveDoc, ws, new Uint8Array([MSG_PROBE]));
  return { sent, unchanged: Buffer.compare(before, Y.encodeStateAsUpdate(ydoc)) === 0 };
}

describe('a probe on a doc socket', () => {
  it('is answered with the same byte and changes nothing', () => {
    const { sent, unchanged } = ask({});
    expect(sent).toEqual([new Uint8Array([MSG_PROBE])]);
    expect(unchanged).toBe(true);
  });

  it('is answered on a read-only socket and a presence-only one', () => {
    expect(ask({ readOnly: true }).sent).toHaveLength(1);
    expect(ask({ presenceOnly: true }).sent).toHaveLength(1);
  });
});
