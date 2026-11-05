/**
 * What the org sign-in's approval shows and what it takes from the screen
 * (`infra/project-machine/org-signin.ts`): the screen `claude setup-token`
 * prints passes through with every token hidden, however the terminal UI
 * breaks it up, and only a whole token is taken from it. Pure functions over
 * fixture screens; the approval itself is driven in
 * `project-machine-org-signin.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { Redactor, tokenIn } from '../../../infra/project-machine/org-signin.ts';

/** As long as a real token (~108 characters), and distinct, so a leak names itself. */
const pad = (s: string) => `${s}-${'x'.repeat(108 - s.length - 1)}`;
const TOKEN = {
  harborlight: pad('sk-ant-oat01-fixture-harborlight-lead-0Aa1Bb2Cc3'),
  riverbend: pad('sk-ant-oat01-fixture-riverbend-lead-4Dd5Ee6Ff7'),
};

describe('the approval’s screen never shows the token', () => {
  // The tail no line of the screen may show: past the shared prefix.
  const tail = (t: string) => t.slice(13, 40);
  const shows = (chunks: string[]) => {
    const r = new Redactor();
    return chunks.map((c) => r.push(c)).join('') + r.end();
  };

  it('holds back a token split across writes, and passes the rest through', () => {
    const r = new Redactor();
    const t = TOKEN.harborlight;
    const out = [
      r.push('Your OAuth token:\r\n\r\n'),
      r.push(t.slice(0, 4)),
      r.push(t.slice(4, 22)),
      r.push(`${t.slice(22)}\r\n\r\nStore this s`),
      r.push('ecurely.'),
      r.end(),
    ].join('');
    expect(out).not.toContain(t.slice(0, 10));
    expect(out).toContain('Your OAuth token:');
    expect(out).toContain('[token hidden]');
    expect(out).toContain('Store this securely.');
  });

  it('hides a token an escape code breaks, in its body or its prefix', () => {
    const t = TOKEN.harborlight;
    for (const screen of [
      `${t.slice(0, 18)}\x1b[0m${t.slice(18)}\r\n`,
      `${t.slice(0, 30)}\x1b[1C${t.slice(30)}\r\n`,
      `sk-\x1b[1mant-${t.slice(7)}\r\n`,
    ]) {
      const out = shows([screen]);
      expect(out).not.toContain(tail(t));
      expect(out).not.toContain(t.slice(60));
      // An escape code split across writes is held, not shown half.
      const split = screen.indexOf('\x1b') + 1;
      const parts = shows([screen.slice(0, split), screen.slice(split)]);
      expect(parts).not.toContain(tail(t));
      expect(parts).not.toContain(t.slice(60));
    }
  });

  it('hides a token a line break wraps, and the line it wraps onto', () => {
    const t = TOKEN.riverbend;
    for (const at of [40, 80]) {
      const out = shows([`token:\r\n${t.slice(0, at)}\r\n${t.slice(at)}\r\n\r\nStore it.`]);
      expect(out).not.toContain(t.slice(at, at + 20));
      expect(out).not.toContain(tail(t));
      expect(out).toContain('token:');
    }
  });

  it('refuses a token the screen wrapped or cut short, rather than set part of one', () => {
    const t = TOKEN.riverbend;
    expect(tokenIn(`${t.slice(0, 80)}\r\n${t.slice(80)}\r\n\r\nStore it.`)).toBeNull();
    expect(tokenIn(`${t.slice(0, 40)}\r\n${t.slice(40)}\r\n`)).toBeNull();
    expect(tokenIn(`${t.slice(0, 60)}\r\n\r\nStore it.`)).toBeNull();
    expect(tokenIn(`\r\n${t}\r\n\r\nStore this token securely.`)).toBe(t);
  });

  it('finds the one token in the screen, through colour codes and redraws', () => {
    const screen = `\x1b[2K\x1b[1G${TOKEN.riverbend}\r\n\x1b[2K${TOKEN.riverbend}\x1b[0m\r\n`;
    expect(tokenIn(screen)).toBe(TOKEN.riverbend);
    expect(tokenIn('Login failed')).toBeNull();
    expect(tokenIn(`${TOKEN.riverbend}\n${TOKEN.harborlight}`)).toBeNull();
  });
});
