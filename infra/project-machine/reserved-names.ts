/**
 * Project names that would land on something another job owns. A project
 * `<p>` deploys in the GitHub Environment `fly-<p>` (`ci-tokens.ts`) to the
 * Fly app `cw-<p>` (`deploy-plan.ts`), so a project named after one of these
 * would share that environment's token or that app (24 Nov wall re-review,
 * L1). `machines.ts` refuses such a name and `ci-tokens.ts` refuses it again
 * before cutting any token: this is the one list both read.
 *
 * The `fly-ci/` Terraform root checks only an environment name's shape, so
 * there is no second list there to keep in step.
 */

/** fly-ci-tokens.yml's environment: the org token. */
export const ORG_ENVIRONMENT = 'fly-org';
/** wall-read.yml's `fly` job: the read-only token. */
export const READ_ENVIRONMENT = 'fly-org-read';
/** app-kit-staging.yml's environment: the staging trial's deploy token. */
export const STAGING_ENVIRONMENT = 'fly-appkit-staging';
/** The network wall test's throwaway apps (`network-wall-plan.ts`) are `cw-walltest-*`. */
export const WALLTEST_PREFIX = 'walltest-';

const RESERVED: ReadonlyMap<string, string> = new Map([
  [ORG_ENVIRONMENT, "the org token's environment"],
  [READ_ENVIRONMENT, "the read token's environment"],
  [STAGING_ENVIRONMENT, "the staging trial's environment"],
]);

/** Why `project` may not be used, or null when it may. */
export function reservedProject(project: string): string | null {
  const owner = RESERVED.get(`fly-${project}`);
  if (owner) return `a project named ${project} would share fly-${project}, ${owner}`;
  if (project.startsWith(WALLTEST_PREFIX))
    return `a project named ${project} would be cw-${project}, an app the network wall test makes and destroys`;
  return null;
}
