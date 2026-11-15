/**
 * The contract for the component routes an agent calls on a bound `.mdx` doc
 * (`route-contract.ts` says what a contract is). `doc-component-agent.ts`
 * serves every one, and each write reads its body as the type declared here.
 * No component tool reads a field of the answer, so none is declared.
 *
 * `author` is resolved by `parseSuggestionAuthor`, so it is `unknown` here.
 */
import { Hono } from 'hono';
import { contractOnly, json, query } from './route-contract.ts';

/** `?path=` reads one key of the state rather than all of it. */
export type ComponentStateQuery = { path?: string };
export interface SetComponentStateBody {
  ops: unknown;
  author: unknown;
}
export interface PlaceComponentBody {
  importPath: unknown;
  name?: unknown;
  props: unknown;
  headingId?: unknown;
  author: unknown;
}
export interface ComponentGrantBody {
  folder: unknown;
  taskId: unknown;
  why: unknown;
  author: unknown;
}

const DOC = '/workspaces/:ws/docs/:docId';
const STATE = `${DOC}/agent-components/:id/state`;

export const docComponentsContract = new Hono()
  .get(`${DOC}/agent-components`, contractOnly)
  .get(STATE, query<ComponentStateQuery>(), contractOnly)
  .post(STATE, json<SetComponentStateBody>(), contractOnly)
  .post(`${DOC}/agent-components/place`, json<PlaceComponentBody>(), contractOnly)
  .post(`${DOC}/component-grants`, json<ComponentGrantBody>(), contractOnly);

export type DocComponentsContract = typeof docComponentsContract;
