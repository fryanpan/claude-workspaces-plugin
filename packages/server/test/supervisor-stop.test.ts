import { describe, expect, it } from 'bun:test';
import { STOP_SIGNALS, stopExitCode, stopLogLine } from '../src/supervisor-stop.ts';

describe('stopExitCode', () => {
  it('is never 0 under launchd, and says which signal it was', () => {
    expect(stopExitCode('SIGHUP', true)).toBe(129);
    expect(stopExitCode('SIGINT', true)).toBe(130);
    expect(stopExitCode('SIGTERM', true)).toBe(143);
  });

  it('is 0 in a terminal, for every stop signal', () => {
    for (const signal of STOP_SIGNALS) expect(stopExitCode(signal, false)).toBe(0);
  });
});

describe('stopLogLine', () => {
  it('names the signal and the code', () => {
    const line = stopLogLine('SIGTERM', 143);
    expect(line).toContain('SIGTERM');
    expect(line).toContain('exiting 143');
  });

  it('stays silent on a clean exit', () => {
    expect(stopLogLine('SIGINT', 0)).toBeNull();
  });
});
