/**
 * `access.local.json` (infra/access-apps/access-plan.ts): which config it
 * accepts, and the per-host audiences it hands each server. The applications
 * and policies made from it are the OpenTofu config's (infra/cloudflare), and
 * what a plan builds is asserted in infra/cloudflare/tests.
 */
import { describe, expect, it } from 'bun:test';
import { hostAudiencesFor, parseAccessConfig } from '../../../infra/access-apps/access-plan.ts';

const ONE = 'workspaces.harborlight.test';
const RIVER = `riverbend.${ONE}`;
const SALT = `saltmarsh.${ONE}`;
const cfg = (projects: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  parseAccessConfig(JSON.stringify({ projects, ...over }));

describe('parseAccessConfig', () => {
  it('reads each project, with a 24h sign-in by default', () => {
    const c = cfg({ riverbend: { hosts: [RIVER], emailDomains: ['riverbend.test'] } });
    expect(c.sessionDuration).toBe('24h');
    expect(c.projects.riverbend).toEqual({
      hosts: [RIVER],
      emails: [],
      emailDomains: ['riverbend.test'],
      serviceTokens: [],
    });
  });

  it('refuses one host under two projects', () => {
    expect(() =>
      cfg({ riverbend: { hosts: [RIVER] }, saltmarsh: { hosts: [SALT, RIVER] } }),
    ).toThrow(/both riverbend and saltmarsh/);
  });

  it('refuses a project with no hosts, a bad host, a bad domain, or a bad duration', () => {
    expect(() => cfg({ riverbend: { hosts: [] } })).toThrow(/no hosts/);
    expect(() => cfg({ riverbend: { hosts: ['Riverbend.Test'] } })).toThrow(/hostname/);
    expect(() => cfg({ riverbend: { hosts: [RIVER], emailDomains: ['@x'] } })).toThrow(/domain/);
    expect(() => cfg({ riverbend: { hosts: [RIVER] } }, { sessionDuration: '1 week' })).toThrow(
      /hours/,
    );
  });
});

describe('hostAudiencesFor', () => {
  it("maps every host of a server's projects to its own application's audience", () => {
    const c = cfg({ riverbend: { hosts: [RIVER] }, saltmarsh: { hosts: [SALT, `board.${SALT}`] } });
    expect(hostAudiencesFor(c, ['saltmarsh'], (l) => `aud-${l}`)).toEqual({
      [SALT]: 'aud-saltmarsh',
      [`board.${SALT}`]: 'aud-saltmarsh',
    });
    expect(() => hostAudiencesFor(c, ['harborlight'], (l) => l)).toThrow(/no project/);
  });
});
