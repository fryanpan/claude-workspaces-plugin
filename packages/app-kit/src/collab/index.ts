/**
 * The collab core, as the app kit package exports it. In this repo it
 * re-exports `@claude-workspaces/core/collab`; `scripts/pack.ts` replaces
 * this folder with that folder's own files, so the packed package carries
 * the core itself and needs nothing from this repo.
 */
export * from '@claude-workspaces/core/collab';
