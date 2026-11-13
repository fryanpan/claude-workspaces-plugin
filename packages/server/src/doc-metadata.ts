import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
/**
 * A bound doc's metadata on the server: which schema governs it, what its
 * front matter holds, and the one write that sets fields.
 *
 * The rules are core's (`core/src/doc-metadata.ts`); the contract is
 * docs/architecture/doc-metadata.md. This module adds the two things only
 * the server can do: find the schema file on disk, and edit the live doc.
 *
 * **Finding the schema.** `.workspaces/doc-metadata.schema.json` in the
 * doc's folder, then each parent, stopping after the first folder that holds
 * `.git` (the repository's top), the doc's folder-bind root, or the home
 * folder. The nearest file wins. Every stat and read goes through
 * `boundFiles.guards`, so a walled lead's tree is read as `tree-fs` reads it.
 *
 * **Editing.** The front matter is the doc's first block, a `codeBlock` in
 * `FRONT_MATTER_LANGUAGE`. A set rewrites only the characters that differ, in
 * one transaction under a string origin, so the write-back flushes it like
 * any agent edit and every open page receives it over its socket.
 */
import { prose } from '@claude-workspaces/core';
import {
  DOC_METADATA_SCHEMA_PATH,
  FRONT_MATTER_LANGUAGE,
  type MetadataSchema,
  type MetadataValue,
  parseMetadataSchema,
  setMetadataFields,
} from '@claude-workspaces/core/doc-metadata';
import * as Y from 'yjs';
import { GuardRefused, type PathGuards } from './bound-path-guard.ts';

/** A schema file larger than this is not a form's description. */
export const SCHEMA_MAX_BYTES = 64 * 1024;

/** How many folders up the search may climb before it gives up. */
const MAX_DEPTH = 32;

/** The transaction origin of a metadata set. Not 'file-watch', so it flushes. */
export const METADATA_ORIGIN = 'agent-metadata';

/**
 * Why a doc has no schema: `not-file-bound` (no file to search from),
 * `no-file` (no schema file between the doc and the search's top),
 * `unreadable` (found, but could not be read safely or is too large), or
 * `invalid` (read, but not JSON or not a schema this module understands).
 */
export type SchemaReason = 'not-file-bound' | 'no-file' | 'unreadable' | 'invalid';

export type SchemaLookup =
  | { found: false }
  | { found: true; at: string; schema: MetadataSchema }
  | { found: true; at: string; error: string; reason: 'unreadable' | 'invalid' };

/**
 * The schema governing the file at `mdPath`. `at` is the schema's path
 * relative to the doc's own folder, the only spelling that leaves the server.
 */
export function findMetadataSchema(
  mdPath: string,
  guards: PathGuards,
  stopAt?: string,
): SchemaLookup {
  const start = dirname(mdPath);
  const home = homedir();
  let dir = start;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const candidate = join(dir, DOC_METADATA_SCHEMA_PATH);
    const at = relative(start, candidate);
    let exists = false;
    try {
      exists = guards.exists(candidate);
    } catch {
      exists = false;
    }
    if (exists) {
      let text: string | 'too-large';
      try {
        text = guards.readBoundedSync(candidate, SCHEMA_MAX_BYTES);
      } catch (err) {
        const why =
          err instanceof GuardRefused ? 'it could not be read safely' : 'it is unreadable';
        return {
          found: true,
          at,
          error: `the schema file was found but ${why}`,
          reason: 'unreadable',
        };
      }
      if (text === 'too-large') {
        return {
          found: true,
          at,
          error: `the schema file is over ${SCHEMA_MAX_BYTES} bytes`,
          reason: 'unreadable',
        };
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { found: true, at, error: 'the schema file is not valid JSON', reason: 'invalid' };
      }
      const parsed = parseMetadataSchema(json);
      return parsed.ok
        ? { found: true, at, schema: parsed.schema }
        : { found: true, at, error: parsed.error, reason: 'invalid' };
    }
    let isTop = dir === stopAt || dir === home;
    try {
      isTop = isTop || guards.exists(join(dir, '.git'));
    } catch {
      isTop = true;
    }
    const parent = dirname(dir);
    if (isTop || parent === dir) break;
    dir = parent;
  }
  return { found: false };
}

/** The doc's front-matter block, when its first block is one. */
function frontMatterBlock(ydoc: Y.Doc): Y.XmlElement | null {
  const first = prose.getProseFragment(ydoc).get(0);
  return first instanceof Y.XmlElement &&
    first.nodeName === 'codeBlock' &&
    first.getAttribute('language') === FRONT_MATTER_LANGUAGE
    ? first
    : null;
}

/** The YAML between the doc's `---` lines, or null when it has none. */
export function frontMatterOf(ydoc: Y.Doc): string | null {
  const block = frontMatterBlock(ydoc);
  if (!block) return null;
  return block
    .toArray()
    .map((c) => (c instanceof Y.XmlText ? c.toString() : ''))
    .join('');
}

/** Replace `text`'s content with `next`, touching only what differs. */
function patchText(text: Y.XmlText, next: string): void {
  const prev = text.toString();
  let head = 0;
  while (head < prev.length && head < next.length && prev[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < prev.length - head &&
    tail < next.length - head &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail++;
  const del = prev.length - head - tail;
  if (del > 0) text.delete(head, del);
  const ins = next.slice(head, next.length - tail);
  if (ins) text.insert(head, ins);
}

/**
 * Set `updates` in the doc's front matter: the caller has checked them
 * against `schema` (`checkUpdates`). Creates the block when the doc has none,
 * and removes it when the last field goes.
 */
export function setDocMetadata(
  ydoc: Y.Doc,
  schema: MetadataSchema,
  updates: Record<string, MetadataValue | null>,
): void {
  const before = frontMatterOf(ydoc);
  const next = setMetadataFields(schema, before, updates);
  if (next === before) return;
  ydoc.transact(() => {
    const fragment = prose.getProseFragment(ydoc);
    const block = frontMatterBlock(ydoc);
    if (next === null) {
      if (block) fragment.delete(0, 1);
      return;
    }
    if (block) {
      const text = block.get(0);
      if (text instanceof Y.XmlText) {
        patchText(text, next);
        return;
      }
      fragment.delete(0, 1);
    }
    const cb = new Y.XmlElement('codeBlock');
    cb.setAttribute('language', FRONT_MATTER_LANGUAGE);
    const t = new Y.XmlText();
    t.insert(0, next);
    cb.insert(0, [t]);
    fragment.insert(0, [cb]);
  }, METADATA_ORIGIN);
}
