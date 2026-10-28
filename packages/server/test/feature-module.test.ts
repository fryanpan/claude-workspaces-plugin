/**
 * The registration shape's two helpers (feature-module.ts): a list of
 * started families answers in list order and stops in list order.
 */
import { describe, expect, it } from 'bun:test';
import {
  type FeatureInstance,
  type FeatureRequest,
  chainFeatureRoutes,
  stopFeatures,
} from '../src/feature-module.ts';

const rq = (pathname: string): FeatureRequest => ({
  req: new Request(`http://localhost${pathname}`),
  pathname,
  visitor: null,
  ownerProven: () => false,
  requestOrigin: () => undefined,
});

/** A family that claims one prefix and records every request it was shown. */
const family = (prefix: string, seen: string[], status = 200): FeatureInstance => ({
  routes: ({ pathname }) => {
    seen.push(`${prefix}:${pathname}`);
    return pathname.startsWith(prefix) ? new Response(prefix, { status }) : undefined;
  },
});

describe('chainFeatureRoutes', () => {
  it('answers with the first family that claims the address, in list order', async () => {
    const seen: string[] = [];
    const routes = chainFeatureRoutes([
      family('/a/', seen),
      family('/b/', seen),
      family('/b/', seen, 418),
    ]);
    const res = await routes(rq('/b/x'));
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe('/b/');
    // The third family, which also claims `/b/`, is never asked.
    expect(seen).toEqual(['/a/:/b/x', '/b/:/b/x']);
  });

  it('declines with null when no family claims the address', async () => {
    const seen: string[] = [];
    const routes = chainFeatureRoutes([family('/a/', seen), { stop: () => {} }]);
    expect(await routes(rq('/z'))).toBeNull();
    expect(seen).toEqual(['/a/:/z']);
  });

  it('awaits an async family before asking the next', async () => {
    const order: string[] = [];
    const routes = chainFeatureRoutes([
      {
        routes: async () => {
          await Promise.resolve();
          order.push('slow');
          return null;
        },
      },
      {
        routes: () => {
          order.push('next');
          return new Response('ok');
        },
      },
    ]);
    expect((await routes(rq('/x')))?.status).toBe(200);
    expect(order).toEqual(['slow', 'next']);
  });
});

describe('stopFeatures', () => {
  it('stops every family that has a stop, in list order, synchronously', () => {
    const stopped: string[] = [];
    stopFeatures([
      { stop: () => stopped.push('one') },
      { routes: () => null },
      { stop: () => stopped.push('two') },
    ]);
    // Synchronous: the shutdown stretch it runs in has no await before
    // the socket drain.
    expect(stopped).toEqual(['one', 'two']);
  });

  it('lets a throw propagate, as an inline teardown line would', () => {
    const stopped: string[] = [];
    expect(() =>
      stopFeatures([
        {
          stop: () => {
            throw new Error('boom');
          },
        },
        { stop: () => stopped.push('after') },
      ]),
    ).toThrow('boom');
    expect(stopped).toEqual([]);
  });
});
