/**
 * @vitest-environment happy-dom
 *
 * Core runs under `node` by default — a DOM costs ~170ms per test FILE and
 * almost nothing here needs one. This file asks for one because `receiptHtml`
 * has a caller that PARSES it: `receiptMark` in the app does
 * `innerHTML = receiptHtml(state)` and returns `firstElementChild`, so "one
 * root element" is load-bearing there and only a parser can check it.
 */
import { describe, expect, it } from 'vitest';
import { type ReceiptComment, receiptHtml, receiptState } from './comment-receipt.ts';

const mine = (over: Partial<ReceiptComment> = {}): ReceiptComment => ({
  id: 'c1',
  ts: 1000,
  author: { id: 'u-bryan', name: 'Bryan' },
  ...over,
});

const theirs = (over: Partial<ReceiptComment> = {}): ReceiptComment => ({
  id: 'c2',
  ts: 2000,
  author: { id: 'agent-harborlight', name: 'Harborlight' },
  ...over,
});

const reader = { id: 'u-bryan', name: 'Bryan' };

describe('receiptState', () => {
  it('marks the reader own comment sent once it is in the thread', () => {
    expect(receiptState(mine(), [mine()], reader)).toBe('sent');
  });

  it('marks it received once the server stamped a delivery', () => {
    const c = mine({ deliveredAt: 1500 });
    expect(receiptState(c, [c], reader)).toBe('received');
  });

  it('draws nothing on somebody else comment', () => {
    expect(receiptState(theirs(), [mine(), theirs()], reader)).toBeNull();
  });

  it('draws nothing for a reader who is nobody', () => {
    expect(receiptState(mine(), [mine()], undefined)).toBeNull();
  });

  it('goes away once a reply from somebody else lands after it', () => {
    const c = mine({ deliveredAt: 1500 });
    expect(receiptState(c, [c, theirs()], reader)).toBeNull();
  });

  it('stays while the only later comment is the reader own', () => {
    const c = mine({ deliveredAt: 1500 });
    const second = mine({ id: 'c3', ts: 3000 });
    expect(receiptState(c, [c, second], reader)).toBe('received');
  });

  it('stays when somebody else spoke BEFORE it — a reply is what comes after', () => {
    const c = mine({ ts: 5000 });
    expect(receiptState(c, [theirs(), c], reader)).toBe('sent');
  });

  it('identifies the reader by name when neither side carries an id', () => {
    const c: ReceiptComment = { id: 'c1', ts: 1, author: { name: ' bryan ' } };
    expect(receiptState(c, [c], { name: 'Bryan' })).toBe('sent');
  });

  it('trusts the id over the name when both sides carry one', () => {
    const c: ReceiptComment = { id: 'c1', ts: 1, author: { id: 'agent-x', name: 'Bryan' } };
    expect(receiptState(c, [c], reader)).toBeNull();
  });
});

describe('receiptHtml', () => {
  it('titles the two states the way the reader reads them', () => {
    expect(receiptHtml('sent')).toContain('title="Sent"');
    expect(receiptHtml('received')).toContain('title="Received"');
  });

  it('carries the state on the element, so one stylesheet rule shows the second tick', () => {
    expect(receiptHtml('received')).toContain('data-receipt="received"');
  });

  it('is exactly one root element, which is what the app parses out of it', () => {
    for (const state of ['sent', 'received'] as const) {
      const box = document.createElement('div');
      box.innerHTML = receiptHtml(state);
      // Not `firstElementChild !== null`: the app takes the first and drops
      // the rest, so a second root would be silently lost on that surface and
      // drawn on the widget's.
      expect(box.children, state).toHaveLength(1);
      expect(box.firstElementChild?.tagName, state).toBe('SPAN');
      // CONTROL: the count is a real one — the same box given two roots says 2.
      box.innerHTML = receiptHtml(state) + receiptHtml(state);
      expect(box.children, state).toHaveLength(2);
    }
  });

  it('draws both ticks in both states, so the time beside it never moves', () => {
    for (const state of ['sent', 'received'] as const) {
      const html = receiptHtml(state);
      expect(html.match(/<path /g)).toHaveLength(2);
    }
  });
});
