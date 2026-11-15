/**
 * The meeting driver's page steps fail by name when the browser stops
 * answering, rather than holding the run until its overall deadline. On main
 * 00529b058 a load event or CDP answer that never came held the driver from
 * "move to tasks at 430" to "gave up after 230s", naming nothing.
 *
 * audit: no-text — a fake CDP client; nothing here reads a source file.
 */
import { describe, expect, it } from 'vitest';
import type { Cdp } from '../../../scripts/headless-chrome.ts';
import { bounded, go } from './lead-chat-meeting-page.ts';

const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** A page whose navigation is answered and whose load event never fires. */
const stuckLoad = {
  send: async () => ({}),
  once: () => never(),
  evaluate: async () => ({}),
} as unknown as Cdp;

describe('the meeting driver’s page steps', () => {
  it('names the load event that never came, and the page it was for', async () => {
    await expect(go(stuckLoad, 'http://127.0.0.1:1/workspaces/w-1', 20)).rejects.toThrow(
      'the load event of /workspaces/w-1 did not finish within 20ms',
    );
  });

  it('names a CDP call that never answers', async () => {
    await expect(bounded(never(), 'reading the page', 20)).rejects.toThrow(
      'reading the page did not finish within 20ms',
    );
  });

  it('passes an answer through unchanged', async () => {
    await expect(bounded(Promise.resolve(7), 'reading the page', 20)).resolves.toBe(7);
  });
});
