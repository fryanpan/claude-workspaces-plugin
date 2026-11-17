/**
 * The server finds its Maps key in `CW_GOOGLE_MAPS_KEY`, or else in the file
 * `infra/gcp-maps` writes, and has none, quietly, when neither is there. Every
 * case runs against a temporary home directory and a fake key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  GOOGLE_MAPS_KEY_FILE,
  googleMapsKeyPath,
  resolveGoogleMapsKey,
} from '../src/google-maps-key.ts';

const FILE_KEY = 'fixture-maps-key-Riverbend-file';
const ENV_KEY = 'fixture-maps-key-Harborlight-env';

describe('resolveGoogleMapsKey', () => {
  let home: string;
  let warned: string[];
  const keyFile = () => join(home, GOOGLE_MAPS_KEY_FILE);
  const writeKey = (body: string, path = keyFile()) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { mode: 0o600 });
  };
  const resolve = (env: Record<string, string | undefined> = {}, uid?: number) =>
    resolveGoogleMapsKey({
      env,
      home,
      ...(uid === undefined ? {} : { uid }),
      warn: (l) => warned.push(l),
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'maps-key-'));
    warned = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('reads the key from the file Terraform writes under the home directory', () => {
    writeKey(`${FILE_KEY}\n`);
    expect(googleMapsKeyPath({}, home)).toBe(keyFile());
    expect(resolve()).toBe(FILE_KEY);
    expect(warned).toEqual([]);
  });

  it('prefers CW_GOOGLE_MAPS_KEY over the file', () => {
    writeKey(FILE_KEY);
    expect(resolve({ CW_GOOGLE_MAPS_KEY: ` ${ENV_KEY} ` })).toBe(ENV_KEY);
  });

  it('reads the file CW_GOOGLE_MAPS_KEY_FILE names instead of the default', () => {
    const other = join(home, 'elsewhere', 'maps-key');
    writeKey(FILE_KEY, other);
    expect(resolve({ CW_GOOGLE_MAPS_KEY_FILE: other })).toBe(FILE_KEY);
  });

  it('has no key, and says nothing, when neither source is there', () => {
    expect(resolve()).toBeUndefined();
    expect(warned).toEqual([]);
  });

  it('skips a file it should not trust, naming the path and never the contents', () => {
    const target = join(home, 'real-key');
    writeKey(FILE_KEY, target);
    mkdirSync(dirname(keyFile()), { recursive: true });
    symlinkSync(target, keyFile());
    expect(resolve()).toBeUndefined();
    rmSync(keyFile());
    writeKey('not a key at all');
    expect(resolve()).toBeUndefined();
    rmSync(keyFile());
    writeKey(FILE_KEY);
    chmodSync(keyFile(), 0o600);
    expect(resolve({}, (process.getuid?.() ?? 0) + 1)).toBeUndefined();
    expect(warned).toHaveLength(3);
    for (const line of warned) {
      expect(line).toContain(keyFile());
      expect(line).not.toContain(FILE_KEY);
    }
  });
});
