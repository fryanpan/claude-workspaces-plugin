/**
 * Start the app: `bun run start` after `bun run build`.
 *
 *   PORT       default 3000; 0 picks a free port
 *   HOST       default 127.0.0.1
 *   DATA_DIR   where docs are saved, default ./data
 *   APP_ENV    `production` refuses the development sign-in
 *
 * Prints one line, `listening on <url>`, once it accepts connections.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { createApp } from './app.ts';
import { FileCollabStorage } from './file-storage.ts';
import { devSignIn } from './sign-in.ts';

const root = join(import.meta.dirname, '..');
if (!existsSync(join(root, 'dist'))) {
  console.error('No dist/ yet: run `bun run build` first.');
  process.exit(1);
}
const signIn = devSignIn();
if (signIn.devOnly && process.env.APP_ENV === 'production') {
  console.error('Refusing to start: the development sign-in lets anyone be anyone.');
  console.error('Put a real provider in src/sign-in.ts before APP_ENV=production.');
  process.exit(1);
}

const { fetch, websocket, host } = createApp({
  appName: pkg.name,
  signIn,
  storage: new FileCollabStorage(process.env.DATA_DIR ?? join(root, 'data')),
  distDir: join(root, 'dist'),
});

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? '127.0.0.1',
  fetch,
  websocket,
});
console.log(`listening on http://${server.hostname}:${server.port}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    host.flush();
    server.stop(true);
    process.exit(0);
  });
}
