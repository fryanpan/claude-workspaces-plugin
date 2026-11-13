/**
 * Which module answered a request, read off the running server with no
 * change to it.
 *
 * `route-answers.test.ts` uses this to record the handler behind every
 * route-table row. It replaces each module under `src/routes/` (and the three
 * gate modules) with a copy whose route functions note when they answer, via
 * `mock.module`, before `server.ts` is imported. Production code carries no
 * hook for it.
 *
 * WHAT COUNTS AS ANSWERING. A `handle*` or `serve*` export, or the same names
 * on what a `create*` factory returns, answers when it returns anything but
 * null or undefined: that is the fall-through convention every family in the
 * chain follows. The gates answer when they refuse: `admit` returning
 * `{ admitted: false }`, `attributeRequest` returning `{ attributed: false }`,
 * and `resolveWorkspaceScope` returning `{ kind: 'refused' }`. A request none of
 * these answered was answered inline by the chain itself (the CORS preflight,
 * the bad-path refusal, the final 404), and reads `chain`.
 *
 * A family that delegates to another module records both, outermost first:
 * `workspaces.ts:handleWorkspaceRoutes > workspaces-create-read.ts:…`.
 *
 * A return value is never changed, and a synchronous function stays
 * synchronous: several callers chain with `??` without awaiting, and a
 * Promise there would read as an answer.
 *
 * `mock.module` lasts for the rest of the test process, so other files run in
 * the same process see these copies too. That is why a copy must behave
 * exactly as the module it replaces: it only records.
 *
 * Not spied on: the chain modules themselves (`request-chain*.ts`), the route
 * table, and `hono-front.ts` — those decide which family runs and are not
 * families. A Hono family that moves later is registered from its own module,
 * whose `handle*` functions are still spied on.
 */
import { mock } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');
const NOT_FAMILIES = /^(request-chain.*|route-table.*|hono-front)\.ts$/;
const ROUTE_FUNCTION = /^(handle|serve)/;

/** The gate functions, and the return values that mean "refused". */
const GATES: ReadonlyArray<{ file: string; name: string; refused: (r: unknown) => boolean }> = [
  {
    file: 'request-admission.ts',
    name: 'admit',
    refused: (r) => (r as { admitted?: boolean }).admitted === false,
  },
  {
    file: 'request-attribution.ts',
    name: 'attributeRequest',
    refused: (r) => (r as { attributed?: boolean }).attributed === false,
  },
  {
    file: 'middleware/workspace-scope.ts',
    name: 'resolveWorkspaceScope',
    refused: (r) => (r as { kind?: string }).kind === 'refused',
  },
];

export interface RouteHandlerSpy {
  /** Forget the previous request. Call before each one. */
  begin(): void;
  /** Who answered the request since `begin`. */
  answeredBy(): string;
}

type Fn = (...args: unknown[]) => unknown;

export async function spyOnRouteHandlers(): Promise<RouteHandlerSpy> {
  let depth = 0;
  let frames: Array<{ depth: number; label: string }> = [];

  const wrap = (fn: Fn, label: string, answered: (r: unknown) => boolean): Fn =>
    function spied(this: unknown, ...args: unknown[]) {
      const at = depth++;
      const settle = (r: unknown) => {
        depth = at;
        if (answered(r)) frames.push({ depth: at, label });
        return r;
      };
      let result: unknown;
      try {
        result = fn.apply(this, args);
      } catch (err) {
        depth = at;
        throw err;
      }
      if (result instanceof Promise) {
        return result.then(settle, (err) => {
          depth = at;
          throw err;
        });
      }
      return settle(result);
    };

  const answers = (r: unknown) => r !== null && r !== undefined;

  /** A factory's result with its route functions spied on. */
  const spiedResult = (result: unknown, file: string): unknown => {
    if (typeof result !== 'object' || result === null) return result;
    return new Proxy(result as Record<string, unknown>, {
      // The target as receiver, not the proxy: a getter reading a private
      // field throws when handed the proxy.
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof key === 'string' && ROUTE_FUNCTION.test(key) && typeof value === 'function') {
          return wrap((value as Fn).bind(target), `${file}:${key}`, answers);
        }
        return value;
      },
    });
  };

  const replace = async (
    file: string,
    swap: (name: string, value: unknown) => unknown,
  ): Promise<void> => {
    const path = join(SRC, file);
    const real = (await import(path)) as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(real)) copy[name] = swap(name, value);
    mock.module(path, () => copy);
  };

  for (const entry of readdirSync(join(SRC, 'routes'))) {
    if (!entry.endsWith('.ts') || NOT_FAMILIES.test(entry)) continue;
    await replace(join('routes', entry), (name, value) => {
      if (typeof value !== 'function') return value;
      if (ROUTE_FUNCTION.test(name)) return wrap(value as Fn, `${entry}:${name}`, answers);
      if (name.startsWith('create')) {
        const factory = value as Fn;
        return (...args: unknown[]) => spiedResult(factory(...args), entry);
      }
      return value;
    });
  }

  for (const gate of GATES) {
    const label = `${gate.file.split('/').pop()}:${gate.name}`;
    await replace(gate.file, (name, value) => {
      if (typeof value !== 'function') return value;
      if (name === gate.name) return wrap(value as Fn, label, gate.refused);
      if (!name.startsWith('create')) return value;
      // The gate is a method on what the factory builds.
      const factory = value as Fn;
      return (...args: unknown[]) => {
        const built = factory(...args) as Record<string, unknown>;
        const method = built?.[gate.name];
        if (typeof method !== 'function') return built;
        return { ...built, [gate.name]: wrap(method as Fn, label, gate.refused) };
      };
    });
  }

  return {
    begin() {
      depth = 0;
      frames = [];
    },
    answeredBy() {
      if (frames.length === 0) return 'chain';
      return [...frames]
        .sort((a, b) => a.depth - b.depth)
        .map((f) => f.label)
        .filter((label, i, all) => all.indexOf(label) === i)
        .join(' > ');
    },
  };
}
