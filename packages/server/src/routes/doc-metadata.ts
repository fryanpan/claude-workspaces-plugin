import { contentKind } from '@claude-workspaces/core';
import {
  type MetadataSchema,
  type MetadataValue,
  checkUpdates,
  readMetadata,
} from '@claude-workspaces/core/doc-metadata';
import { gitLastModified } from '../doc-git-modified.ts';
import { findMetadataSchema, frontMatterOf, setDocMetadata } from '../doc-metadata.ts';
import { boundFiles } from '../slow-fs.ts';
import type { DocResourceRouteRequest, DocRoutesContext } from './docs-routes-context.ts';

/**
 * A doc's metadata fields: `GET` and `PUT /workspaces/<ws>/docs/<docId>/metadata`.
 *
 * `GET` answers the schema that governs the doc (null when none does, and the
 * editor then draws nothing), the values its front matter holds, which fields
 * are wrong and why, and the git-derived defaults. The editor reads only the
 * schema and the defaults, because it reads the values live from the doc; an
 * agent's `get_doc_metadata` reads all of it.
 *
 * `PUT { fields: { key: value | null } }` sets fields. Every key must be a
 * field the schema declares and not read-only, and every value the field's
 * type; otherwise nothing is written and the answer names each wrong field.
 * The contract is docs/architecture/doc-metadata.md.
 *
 * **The gate is trusted-local**, as for the title next door. A share visitor
 * is refused here as well as by the admission layer: the schema search reads
 * the doc's folders, and a set writes the file.
 */
export async function handleDocMetadataRoute(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { req, visitor, rest, docId, doc } = rq;
  const { j } = ctx;
  if (rest !== 'metadata') return undefined;
  if (req.method !== 'GET' && req.method !== 'PUT') return j(405, { error: 'method not allowed' });
  if (visitor) return j(403, { error: 'not available to share visitors' });

  const path = contentKind(doc.meta.type) === 'prose' ? ctx.docStore.boundPathOf(docId) : undefined;
  const lookup = path
    ? findMetadataSchema(path, boundFiles.guards, doc.meta.workspaceRoot)
    : ({ found: false } as const);
  const schema: MetadataSchema | null = lookup.found && 'schema' in lookup ? lookup.schema : null;

  if (req.method === 'PUT') {
    if (!schema) {
      return j(409, {
        error: 'no-schema',
        message:
          lookup.found && 'error' in lookup ? lookup.error : 'no metadata schema governs this doc',
      });
    }
    const body = await ctx.safeJson(req);
    const fields = body?.fields;
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
      return j(400, { error: 'fields must be an object of field names to values' });
    }
    const updates = fields as Record<string, unknown>;
    if (Object.keys(updates).length === 0) return j(400, { error: 'fields must not be empty' });
    const wrong = checkUpdates(schema, updates);
    if (Object.keys(wrong).length > 0) {
      return j(400, { error: 'invalid-fields', fields: wrong });
    }
    setDocMetadata(doc.ydoc, schema, updates as Record<string, MetadataValue | null>);
  }

  if (!lookup.found) return j(200, { docId, schema: null });
  if ('error' in lookup) {
    return j(200, { docId, schema: null, schemaAt: lookup.at, schemaError: lookup.error });
  }
  if (!schema) return j(200, { docId, schema: null });
  const reading = readMetadata(schema, frontMatterOf(doc.ydoc));
  const defaults: Record<string, string> = {};
  if (path && schema.fields.some((f) => f.defaultFrom)) {
    const day = await gitLastModified(path);
    if (day) for (const f of schema.fields) if (f.defaultFrom) defaults[f.key] = day;
  }
  return j(200, { docId, schema, schemaAt: lookup.at, ...reading, defaults });
}
