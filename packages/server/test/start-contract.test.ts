import { describe, expect, it } from 'bun:test';
import { resolveStartContract } from '../src/start-contract.ts';

const PROD_DIR = '/Users/x/Library/Application Support/claude-workspaces/data';

describe('resolveStartContract', () => {
  it("reads prod's launchd start as port 8787 on the CW_DATA_DIR corpus, waiting for its port", () => {
    // Exactly what the plist runs: `bun run scripts/serve.ts --no-watch`, with
    // CW_DATA_DIR set and no port variable.
    expect(
      resolveStartContract(['--no-watch'], { CW_DATA_DIR: PROD_DIR, HOME: '/Users/x' }),
    ).toEqual({
      ok: true,
      port: 8787,
      dataDir: PROD_DIR,
      waitsForPort: true,
    });
  });

  it('refuses a start that names no data dir', () => {
    const start = resolveStartContract(['--no-watch'], {});
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.error).toContain('no data dir');
  });

  it('takes the data dir and port a staging-style start names, and does not wait', () => {
    expect(resolveStartContract(['--port', '8899', '--data-dir', '/tmp/riverbend'], {})).toEqual({
      ok: true,
      port: 8899,
      dataDir: '/tmp/riverbend',
      waitsForPort: false,
    });
  });

  it('lets a later --data-dir override the one the dev script passes', () => {
    const start = resolveStartContract(
      ['--data-dir', 'data', '--data-dir', '/tmp/harborlight'],
      {},
    );
    expect(start.ok && start.dataDir).toBe('/tmp/harborlight');
  });

  it('refuses a port that is not a number rather than binding NaN', () => {
    for (const port of ['abc', '-1', '70000', '']) {
      expect(resolveStartContract(['--port', port, '--data-dir', '/tmp/d'], {}).ok).toBe(false);
    }
  });
});
