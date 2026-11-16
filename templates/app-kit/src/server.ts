/**
 * Start the app: `bun run start` after `bun run build`.
 *
 *   PORT         default 3000; 0 picks a free port
 *   HOST         default 127.0.0.1
 *   DATA_DIR     where docs and accounts are saved, default ./data
 *   APP_URL      the app's public origin; default the address it listens on
 *   AUTH_SECRET  signs session cookies; default a secret made in DATA_DIR
 *   APP_ENV      `production` refuses to start until mail is wired (src/mail.ts)
 *
 * Prints one line, `listening on <url>`, once it accepts connections.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { createApp } from './app.ts';
import { FileCollabStorage } from './file-storage.ts';
import { mailerFromEnv } from './mail.ts';
import { passwordSignIn } from './password-sign-in.ts';

const root = join(import.meta.dirname, '..');
if (!existsSync(join(root, 'dist'))) {
  console.error('No dist/ yet: run `bun run build` first.');
  process.exit(1);
}
const { mailer, real } = mailerFromEnv();
if (!real && process.env.APP_ENV === 'production') {
  console.error(
    'Refusing to start: mail only prints to this terminal, so nobody can verify an account.',
  );
  console.error('Wire a mail provider in src/mail.ts before APP_ENV=production.');
  process.exit(1);
}
const dataDir = process.env.DATA_DIR ?? join(root, 'data');

// Listen first: with PORT=0 the address, and so the default APP_URL, is
// known only now. Requests before the app is ready get a 503.
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? '127.0.0.1',
  fetch: () => new Response('starting', { status: 503 }),
});
const baseURL = process.env.APP_URL ?? `http://${server.hostname}:${server.port}`;

const { fetch, websocket, host } = createApp({
  appName: pkg.name,
  signIn: await passwordSignIn({ dataDir, baseURL, mailer, secret: process.env.AUTH_SECRET }),
  storage: new FileCollabStorage(join(dataDir, 'docs')),
  distDir: join(root, 'dist'),
});
// The placeholder server was typed without socket data; the app's handlers
// carry it. The cast is only that, and @types/bun releases disagree on how
// to spell it.
server.reload({ fetch, websocket } as unknown as Parameters<typeof server.reload>[0]);
console.log(`listening on ${baseURL}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    host.flush();
    server.stop(true);
    process.exit(0);
  });
}
