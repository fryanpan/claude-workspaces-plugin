/**
 * `bun run access:plan`: print the Access applications `access.local.json`
 * describes, as the request bodies a deploy would send. Reads one local file
 * and writes to stdout. It calls no Cloudflare API and needs no token.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accessApps, parseAccessConfig } from './access-plan.ts';

const path = process.argv[2] ?? join(import.meta.dirname, 'access.local.json');
const apps = accessApps(parseAccessConfig(readFileSync(path, 'utf8')));
process.stdout.write(`${JSON.stringify(apps, null, 2)}\n`);
