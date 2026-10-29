/**
 * The shared list of routes a fresh sign-in can be asked for. The body-based
 * exemptions are the server's, tested in `packages/server/test/fresh-signin.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { countedRouteOf, trimTrailingSlashes } from '../src/counted-routes.ts';

describe('countedRouteOf', () => {
  it('names a route by method and path, with trailing slashes or without', () => {
    expect(countedRouteOf('DELETE', '/workspaces/w-1/docs/d-1')).toBe('delete-doc');
    expect(countedRouteOf('DELETE', '/workspaces/w-1/docs/d-1//')).toBe('delete-doc');
    expect(countedRouteOf('POST', '/api/share/sh-1/ttl')).toBe('lengthen-share');
  });

  it('is null for another method on the same path, or a path that is not counted', () => {
    expect(countedRouteOf('POST', '/workspaces/w-1/docs/d-1')).toBeNull();
    expect(countedRouteOf('POST', '/workspaces/w-1/tasks/t-1/archive')).toBeNull();
    expect(countedRouteOf('POST', '/api/auth/logout')).toBeNull();
  });
});

describe('trimTrailingSlashes', () => {
  it('keeps the root', () => {
    expect(trimTrailingSlashes('/')).toBe('/');
    expect(trimTrailingSlashes('//')).toBe('/');
    expect(trimTrailingSlashes('/a/')).toBe('/a');
  });
});
