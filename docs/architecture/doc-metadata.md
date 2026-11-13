# Doc metadata

**Goal:** a repository declares the standard fields its documents carry
(title, status, tags and so on) in one file. The editor shows those fields as a
form at the top of each doc, and the values live in the doc's YAML front
matter, where a site build or any other tool reads them without the board.

This page is the contract. Another repository can rely on what it says, and
the code that implements it is `packages/core/src/doc-metadata.ts` and
`doc-metadata-schema.ts` beside it.

## Where the schema lives

A folder declares its schema in `.workspaces/doc-metadata.schema.json`.

For a doc, the server looks for that file in the doc's own folder, then in
each parent folder. It stops after the first folder that holds `.git` (the
repository's top), the root of a folder bind, or the home folder. The nearest
file wins, so a subfolder can declare a different schema from the repository
default.

With no schema file, the doc has no metadata form, and the editor shows the
front matter as an ordinary code block, as it always has.

A schema file that is not valid JSON, or that uses a type outside the subset
below, is reported by `get_doc_metadata` (`schemaError`), and the editor shows
no form.

## The schema format

The file is a JSON Schema object. The editor reads this subset of it and
ignores every other keyword, so a schema written for a stricter validator
still works here.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Post",
  "type": "object",
  "required": ["title"],
  "properties": {
    "title": { "type": "string", "title": "Title" },
    "summary": { "type": "string", "description": "One or two sentences." },
    "status": { "type": "string", "enum": ["draft", "teaser", "published"] },
    "updated": {
      "type": "string",
      "format": "date",
      "readOnly": true,
      "x-workspaces-default": "git-last-modified"
    },
    "published": { "type": "string", "format": "date" },
    "series": { "type": "string" },
    "order": { "type": "number" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "authors": { "type": "array", "items": { "type": "string" } }
  }
}
```

| Keyword | Where | What the editor does |
| --- | --- | --- |
| `properties` | top level | One field per key, in the order written. At most 40. A key is letters, digits, `_` and `-`. |
| `required` | top level | A blank field in this list is shown as wrong. |
| `title` | top level | The form's accessible name. |
| `type: "string"` | field | A text box. |
| `type: "number"` | field | A number box. |
| `type: "boolean"` | field | A select of Yes and No. |
| `type: "array"`, `items: {"type": "string"}` | field | A text box of comma-separated values. |
| `format: "date"` | string field | A date picker. The value is `YYYY-MM-DD`. |
| `enum` | string field | A select of these values. |
| `title` | field | The label. Without it, the key is the label. |
| `description` | field | The help text: the text box's placeholder and the label's tooltip. |
| `readOnly: true` | field | Shown, not editable. `set_doc_metadata` refuses it too. |
| `x-workspaces-default: "git-last-modified"` | string field | When the field is blank, the editor shows the day of the file's last git commit, in muted text. It never writes that value. |

Any other `type` (an object, an integer, an array of anything but strings) is
an error in the schema, not a field drawn as text, because a text box would
let a person write a value the schema refuses.

## Where the values live

The values are YAML front matter at the top of the `.md` file:

```markdown
---
title: Harborlight fares
status: draft
tags: [fares, transit]
authors:
  - Alice
  - Bob
---

# Harborlight fares
```

The editor reads a subset of YAML: top-level `key: value` lines whose value is
a plain or quoted scalar, a flow list (`[a, b]`) or a block list (`- a`).
Comments, blank lines and keys the schema does not name are allowed and kept.
A value outside the subset (a nested map, a `|` or `>` block) is kept byte for
byte, and its field is shown as one the editor cannot read.

### What the editor writes

- **Only the lines of the field that changed.** Comments, key order, other
  keys and the spelling of other fields stay as they were.
- **A new field goes beside its neighbours** in schema order: after the
  nearest earlier field the file has, else before the nearest later one, else
  at the end.
- **Clearing a field removes its key.** Clearing the last key removes the
  front matter.
- **Text is written plain** when a YAML library reads it back as the same
  text, and double-quoted otherwise: `title: "Harborlight: part 2"`,
  `summary: "2026"`. A date is written plain (`published: 2026-11-12`), which
  a YAML 1.1 reader such as `js-yaml` reads as a date.
- **A list is written as a flow list** (`tags: [a, b]`), unless the file
  already wrote that field as a block list, which stays a block list at its
  own indent.

### What counts as wrong

The editor and `get_doc_metadata` judge each field and name what is wrong:

| Value | Message |
| --- | --- |
| A required field is blank or missing | is required |
| Plain `42` or `true` in a text field | must be text |
| Not `YYYY-MM-DD` in a date field | must be a date (YYYY-MM-DD) |
| Not one of the `enum` values | must be one of … |
| Not a number in a number field | must be a number |
| Not `true` or `false` in a boolean field | must be true or false |
| A single value in a list field | must be a list |
| A list in a single-value field | must be a single value, not a list |
| YAML outside the subset | cannot be read here; edit it in the file |

**Reading never writes.** A wrong value is shown beside its field, and the
file keeps its bytes until somebody sets a field. Setting one field rewrites
only that field's lines, so another wrong field stays as it was.

## How the editor stays live

The server parses the front matter into the doc's first block, a code block
whose language is `yaml-frontmatter`. The form reads its values from that
block and writes by editing the block's text. So a field set by an agent or
on another page reaches every open page through the doc's Yjs socket, within
the same frame it lands, and reaches the file on the next write-back (about
one second). Front matter the form does not touch round-trips byte for byte,
inner blank lines and comments included.

The tests: `packages/server/test/doc-metadata.test.ts` (the schema search, the
write-back to disk, an open page receiving a set, the file unchanged by a read)
and `packages/workspaces-app/test/doc-metadata.test.ts` (the form over the real
editor).

## For agents

- `get_doc_metadata(workspaceId, docId)` answers `schema` (null when no schema
  governs the doc), `schemaAt` (the schema's path relative to the doc's
  folder), `values`, `errors` and `defaults`.
- `set_doc_metadata(workspaceId, docId, fields)` sets fields, where `fields`
  maps a field name to a value, and null or an empty value clears it. A key
  the schema does not declare, a read-only field or a wrong type is refused
  with 400 `invalid-fields`, naming each field, and nothing is written. No
  schema answers 409 `no-schema`.

Both are `GET` and `PUT /workspaces/<ws>/docs/<docId>/metadata`, behind the
trusted-local gate. A share visitor is refused, because the schema search
reads the doc's folders and a set writes its file.

## In a walled lead's folders

The schema search stats and reads through `boundFiles.guards`, as every bound
read does (`lead-tree-containment.md`). The git default runs `git log`, which
the contained git does not allow, so under a lead's root the default is blank.
