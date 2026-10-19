import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDocKey } from '../src/doc-key.ts';
import type { RepoRegistryFile } from '../src/repo-registry-file.ts';
import { RepoRegistry } from '../src/repo-registry.ts';

/**
 * `primaryKeyFor` answers from a docId → keys table instead of walking every
 * key. The coach's privacy check asks it of every doc on a board for every
 * ranked review item, and the walk was what made `GET /api/review-queue`
 * take 2.2s (`review-queue-speed.test.ts`). The table is dropped on every
 * write, so each case here changes the registry after a lookup and asks
 * again. Fixtures are invented.
 */

let tmp: string;
let reg: RepoRegistry;

const key = (repo: string, path: string) => makeDocKey(repo, path);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'repo-registry-lookup-'));
  reg = new RepoRegistry(tmp);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('RepoRegistry.primaryKeyFor', () => {
  it('answers a claim made after an earlier lookup', () => {
    reg.claim(key('harborlight', 'a.md'), 'd-a');
    expect(reg.primaryKeyFor('d-a')).toBe(key('harborlight', 'a.md'));
    expect(reg.primaryKeyFor('d-b')).toBeUndefined();
    reg.claim(key('harborlight', 'b.md'), 'd-b');
    expect(reg.primaryKeyFor('d-b')).toBe(key('harborlight', 'b.md'));
  });

  it('answers the current key after a re-key, and the old one before it', () => {
    const oldKey = key('riverbend', 'plan.md');
    const newKey = key('saltmarsh', 'plan.md');
    reg.claim(oldKey, 'd-plan');
    expect(reg.primaryKeyFor('d-plan')).toBe(oldKey);
    expect(reg.aliasKey(oldKey, newKey)).toEqual({ ok: true, aliased: true });
    expect(reg.primaryKeyFor('d-plan')).toBe(newKey);
  });

  it('forgets a released key and a rolled-back batch', () => {
    const before = reg.snapshot();
    reg.beginBatch();
    reg.claim(key('harborlight', 'c.md'), 'd-c');
    expect(reg.primaryKeyFor('d-c')).toBe(key('harborlight', 'c.md'));
    reg.restore(before);
    expect(reg.primaryKeyFor('d-c')).toBeUndefined();

    reg.claim(key('harborlight', 'd.md'), 'd-d');
    expect(reg.primaryKeyFor('d-d')).toBe(key('harborlight', 'd.md'));
    reg.releaseKey(key('harborlight', 'd.md'));
    expect(reg.primaryKeyFor('d-d')).toBeUndefined();
  });

  it('reads the key table once for a thousand lookups between writes', () => {
    for (let i = 0; i < 200; i++) reg.claim(key('riverbend', `n-${i}.md`), `d-${i}`);
    const data = (reg as unknown as { data: RepoRegistryFile }).data;
    let walks = 0;
    data.docKeys = new Proxy(data.docKeys, {
      ownKeys(target) {
        walks += 1;
        return Reflect.ownKeys(target);
      },
    });
    for (let i = 0; i < 1000; i++) {
      expect(reg.primaryKeyFor(`d-${i % 200}`)).toBe(key('riverbend', `n-${i % 200}.md`));
    }
    expect(walks).toBeLessThanOrEqual(1);
  });
});
