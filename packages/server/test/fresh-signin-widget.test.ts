/**
 * A widget popup token names a person but carries no sign-in time, so a
 * counted action sent with one is always asked (`src/fresh-signin.ts`). A
 * copied token must not hard-delete a doc. Its positive control is the same
 * token's comment, which is not counted and lands.
 */
import { describe, expect, it } from 'bun:test';
import {
  bearer,
  boot,
  postComment,
  signInAndMint,
  stopServersAfterEach,
} from './auth-widget-token-harness.ts';

stopServersAfterEach();

describe('a widget popup token and a counted action', () => {
  it('is asked for a fresh sign-in before deleting a doc, and the doc stays', async () => {
    const { base, dataDir, ws } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com', ws);
    expect((await postComment(base, dataDir, ws, 'widget-doc', token)).status).toBe(200);
    const res = await fetch(`${base}/workspaces/${ws}/docs/widget-doc?force=true`, {
      method: 'DELETE',
      headers: bearer(token),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('confirm-required');
    const still = await fetch(`${base}/workspaces/${ws}/docs/widget-doc?format=json`);
    expect(still.status).toBe(200);
  });
});
