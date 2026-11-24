/**
 * The repository and environment Cloudflare's CI runs in. The infra scripts
 * that write its secrets (`infra/cloudflare/ci-secrets.ts`, `app-secrets.ts`)
 * and the ones that read its runs name them from here, so a secret goes to
 * this repository and nowhere else.
 */
export const CI_REPO = 'fryanpan/claude-workspaces-plugin';
export const CI_ENVIRONMENT = 'cloudflare-prod';
