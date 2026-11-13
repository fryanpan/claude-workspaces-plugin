/**
 * A doc-metadata schema: the JSON Schema subset a folder declares in
 * `.workspaces/doc-metadata.schema.json`, read into the fields the editor
 * draws. The YAML half is `doc-metadata.ts`, which re-exports this module;
 * the contract is docs/architecture/doc-metadata.md.
 */
/** Where a folder declares its schema, relative to the folder. */
export const DOC_METADATA_SCHEMA_PATH = '.workspaces/doc-metadata.schema.json';

/** The `codeBlock` language the parser gives a file's front matter. */
export const FRONT_MATTER_LANGUAGE = 'yaml-frontmatter';

/** The only `x-workspaces-default` value there is. */
export const GIT_LAST_MODIFIED = 'git-last-modified';

export type MetadataFieldType = 'string' | 'number' | 'boolean' | 'string[]';

export interface MetadataField {
  key: string;
  type: MetadataFieldType;
  /** The label: the schema's `title`, else the key. */
  title: string;
  description?: string;
  format?: 'date';
  enum?: string[];
  required: boolean;
  readOnly: boolean;
  /** Shown when the field is blank, and never written. */
  defaultFrom?: typeof GIT_LAST_MODIFIED;
}

export interface MetadataSchema {
  title?: string;
  fields: MetadataField[];
}

export type MetadataValue = string | number | boolean | string[];

/** Most fields one schema may declare: a form, not a database. */
export const MAX_METADATA_FIELDS = 40;

const KEY_RE = /^[A-Za-z_][\w-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read a schema file's parsed JSON into the fields the editor draws, or say
 * what is wrong with it. Keywords outside the subset are ignored; a field
 * whose type is outside it is an error, because drawing it as text would let
 * a person write a value the schema refuses.
 */
export function parseMetadataSchema(
  raw: unknown,
): { ok: true; schema: MetadataSchema } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'the schema must be a JSON object' };
  if (raw.type !== undefined && raw.type !== 'object') {
    return { ok: false, error: 'the schema must have type "object"' };
  }
  const props = raw.properties;
  if (!isRecord(props)) return { ok: false, error: 'the schema must have a "properties" object' };
  const keys = Object.keys(props);
  if (keys.length > MAX_METADATA_FIELDS) {
    return { ok: false, error: `the schema may declare at most ${MAX_METADATA_FIELDS} fields` };
  }
  const required = new Set(
    Array.isArray(raw.required)
      ? raw.required.filter((k): k is string => typeof k === 'string')
      : [],
  );
  const fields: MetadataField[] = [];
  for (const key of keys) {
    if (!KEY_RE.test(key)) {
      return { ok: false, error: `field "${key}": a key is letters, digits, "_" and "-"` };
    }
    const p = props[key];
    if (!isRecord(p)) return { ok: false, error: `field "${key}" must be an object` };
    let type: MetadataFieldType;
    if (p.type === 'string' || p.type === 'number' || p.type === 'boolean') type = p.type;
    else if (p.type === 'array' && isRecord(p.items) && p.items.type === 'string')
      type = 'string[]';
    else {
      return {
        ok: false,
        error: `field "${key}": type must be string, number, boolean, or an array of strings`,
      };
    }
    const field: MetadataField = {
      key,
      type,
      title: typeof p.title === 'string' && p.title.trim() ? p.title : key,
      required: required.has(key),
      readOnly: p.readOnly === true,
    };
    if (typeof p.description === 'string' && p.description.trim()) {
      field.description = p.description;
    }
    if (p.format === 'date') {
      if (type !== 'string') return { ok: false, error: `field "${key}": a date is a string` };
      field.format = 'date';
    }
    if (p.enum !== undefined) {
      if (type !== 'string' || !Array.isArray(p.enum) || p.enum.length === 0) {
        return { ok: false, error: `field "${key}": enum must be a list of strings` };
      }
      if (!p.enum.every((v): v is string => typeof v === 'string')) {
        return { ok: false, error: `field "${key}": enum must be a list of strings` };
      }
      field.enum = [...p.enum];
    }
    const dflt = p['x-workspaces-default'];
    if (dflt !== undefined) {
      if (dflt !== GIT_LAST_MODIFIED || type !== 'string') {
        return {
          ok: false,
          error: `field "${key}": x-workspaces-default must be "${GIT_LAST_MODIFIED}" on a string`,
        };
      }
      field.defaultFrom = GIT_LAST_MODIFIED;
    }
    fields.push(field);
  }
  const schema: MetadataSchema = { fields };
  if (typeof raw.title === 'string' && raw.title.trim()) schema.title = raw.title;
  return { ok: true, schema };
}
