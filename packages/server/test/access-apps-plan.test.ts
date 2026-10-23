/**
 * The Access applications one-per-project needs (infra/access-apps): which
 * config it accepts, the application and policies it builds for each project,
 * and the per-host audiences it hands each server. Nothing here reaches
 * Cloudflare, and nothing in the repo sends these bodies yet.
 */
import { describe, expect, it } from 'bun:test';
import {
  accessApps,
  hostAudiencesFor,
  parseAccessConfig,
} from '../../../infra/access-apps/access-plan.ts';

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

describe('accessApps', () => {
  it('builds one application per project over its own hosts', () => {
    const apps = accessApps(cfg({ riverbend: { hosts: [RIVER] }, saltmarsh: { hosts: [SALT] } }));
    expect(apps.map((a) => [a.name, a.domain, a.self_hosted_domains])).toEqual([
      ['board riverbend', RIVER, [RIVER]],
      ['board saltmarsh', SALT, [SALT]],
    ]);
    for (const a of apps) {
      expect(a.type).toBe('self_hosted');
      expect(a.http_only_cookie_attribute).toBe(true);
      expect(a.same_site_cookie_attribute).toBe('lax');
    }
  });

  it('admits people and whole domains in one allow policy, service tokens in another', () => {
    const [app] = accessApps(
      cfg({
        riverbend: {
          hosts: [RIVER],
          emails: ['alice@riverbend.test'],
          emailDomains: ['riverbend.test'],
          serviceTokens: ['home feed riverbend'],
        },
      }),
    );
    expect(app?.policies).toEqual([
      {
        name: 'riverbend people',
        decision: 'allow',
        include: [
          { email: { email: 'alice@riverbend.test' } },
          { email_domain: { domain: 'riverbend.test' } },
        ],
      },
      {
        name: 'riverbend service tokens',
        decision: 'non_identity',
        include: [{ service_token_name: 'home feed riverbend' }],
      },
    ]);
  });

  it('gives a project with nobody listed no allow policy, so it admits no person', () => {
    const [app] = accessApps(cfg({ riverbend: { hosts: [RIVER], serviceTokens: ['relay'] } }));
    expect(app?.policies.map((p) => p.decision)).toEqual(['non_identity']);
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
