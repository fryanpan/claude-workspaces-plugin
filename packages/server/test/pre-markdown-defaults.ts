/**
 * The shipped prompt defaults as they read on main before the markdown
 * rewrite (8cc724fa), by catalog id — the words
 * `prompt-markdown-migration.ts` recognises by hash. Kept as a fixture so a
 * test can hand the migration the real old text rather than a stand-in.
 * Meeting capture's is left out: it quotes a person's name in an example.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = join(import.meta.dir, 'fixtures', 'pre-markdown-prompts.json');

export function preMarkdownDefaults(): Record<string, string> {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
}

export function readPreMarkdownDefault(id: string): string {
  const text = preMarkdownDefaults()[id];
  if (text === undefined) throw new Error(`no pre-markdown default for ${id}`);
  return text;
}
