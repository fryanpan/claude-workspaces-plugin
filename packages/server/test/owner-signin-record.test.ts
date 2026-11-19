import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_SIGNIN_FILE, createOwnerSignInRecord } from '../src/auth/owner-signin-record.ts';

describe('the owner sign-in record', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'owner-signin-record-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const at = (iso: string) => () => new Date(iso);

  it('reads nothing until a sign-in is recorded', () => {
    expect(createOwnerSignInRecord(dir).read()).toBeNull();
  });

  it('keeps the first sign-in, in a file only this user can read', () => {
    const rec = createOwnerSignInRecord(dir, at('2026-11-19T10:00:00Z'));
    rec.record('owner@harborlight.test');
    expect(rec.read()).toEqual({ email: 'owner@harborlight.test', at: '2026-11-19T10:00:00.000Z' });
    expect(statSync(join(dir, OWNER_SIGNIN_FILE)).mode & 0o777).toBe(0o600);
    // A later sign-in changes nothing.
    createOwnerSignInRecord(dir, at('2026-11-20T10:00:00Z')).record('owner@harborlight.test');
    expect(JSON.parse(readFileSync(join(dir, OWNER_SIGNIN_FILE), 'utf8')).at).toBe(
      '2026-11-19T10:00:00.000Z',
    );
  });

  it('a fresh reader sees what an earlier one wrote', () => {
    createOwnerSignInRecord(dir).record('owner@harborlight.test');
    expect(createOwnerSignInRecord(dir).read()?.email).toBe('owner@harborlight.test');
  });

  it('a torn file is no evidence', () => {
    writeFileSync(join(dir, OWNER_SIGNIN_FILE), '{"email":');
    expect(createOwnerSignInRecord(dir).read()).toBeNull();
  });
});
