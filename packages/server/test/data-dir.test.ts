import { describe, expect, it } from 'bun:test';
import { DATA_DIR_ENV, dataDirFromArgs, resolveDataDir } from '../src/data-dir.ts';

describe('resolveDataDir', () => {
  it('defaults to <repoRoot>/data, which is what dev and staging already had', () => {
    expect(resolveDataDir({}, '/srv/checkout')).toBe('/srv/checkout/data');
  });

  it('honours CW_DATA_DIR, so prod can put the corpus off the checkout', () => {
    expect(resolveDataDir({ [DATA_DIR_ENV]: '/var/cw/data' }, '/srv/checkout')).toBe(
      '/var/cw/data',
    );
  });

  it('accepts a path containing spaces verbatim', () => {
    // The prod root is under `~/Library/Application Support`. Nothing on this
    // path goes through a shell, so the only way a space breaks is if this
    // function mangles it.
    const p = '/Users/x/Library/Application Support/claude-workspaces/data';
    expect(resolveDataDir({ [DATA_DIR_ENV]: p }, '/srv/checkout')).toBe(p);
  });

  it('treats blank and whitespace-only as unset rather than as the filesystem root', () => {
    // A plist key someone emptied out must fall back, not resolve `/data`.
    expect(resolveDataDir({ [DATA_DIR_ENV]: '' }, '/srv/checkout')).toBe('/srv/checkout/data');
    expect(resolveDataDir({ [DATA_DIR_ENV]: '   ' }, '/srv/checkout')).toBe('/srv/checkout/data');
  });

  it('trims surrounding whitespace off a real value', () => {
    expect(resolveDataDir({ [DATA_DIR_ENV]: '  /var/cw/data  ' }, '/srv/checkout')).toBe(
      '/var/cw/data',
    );
  });
});

describe('dataDirFromArgs — the one precedence bin.ts and the config share', () => {
  const env = { [DATA_DIR_ENV]: '/var/cw/data' };
  it('lets --data-dir win over the environment', () => {
    const arg = (name: string) => (name === 'data-dir' ? '/tmp/scratch' : undefined);
    expect(dataDirFromArgs(env, '/srv/checkout', arg)).toBe('/tmp/scratch');
  });

  it('falls back to the resolver without the flag', () => {
    expect(dataDirFromArgs(env, '/srv/checkout', () => undefined)).toBe('/var/cw/data');
  });
});
