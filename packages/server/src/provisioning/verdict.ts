/**
 * The shape a request classifier answers with, and the Fly app-name rule it
 * checks. The keeper's policy (`keeper/keeper-policy.ts`) and the
 * provisioning helpers here both answer in it; it lives here so the infra
 * scripts that call those helpers import nothing from `keeper/`.
 */

export type HoldKind =
  | 'project.create'
  | 'token.move'
  | 'access.open'
  | 'move.grant'
  | 'github.secrets'
  | 'cloudflare.sync'
  | 'service-token.rotate'
  | 'other';

export type Verdict =
  | { kind: 'routine'; app: string | null; summary: string }
  | {
      kind: 'held';
      hold: HoldKind;
      app: string | null;
      summary: string;
      /** A project-setup command a setup grant on `app` may run without a tap. */
      setup?: boolean;
      /** A fly call's argv, which a move grant reads (`keeper-grants.ts`). */
      args?: readonly string[];
    }
  | { kind: 'refused'; reason: string };

/** A Fly app name. */
export const APP_NAME = /^[a-z][a-z0-9-]{1,62}$/;
