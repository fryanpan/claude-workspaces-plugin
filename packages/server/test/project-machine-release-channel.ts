/**
 * A local release store for the self-update tests: a folder, served over
 * HTTP on loopback the way GitHub serves a release's assets, answering 404
 * for a file that is not there.
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

/** A local release store: a folder, served over HTTP on loopback. */
export class Store {
  readonly dir: string;
  private server: ReturnType<typeof Bun.serve>;
  constructor(scratch: string) {
    this.dir = mkdtempSync(join(scratch, 'store-'));
    const dir = this.dir;
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const name = new URL(req.url).pathname.split('/').pop() ?? '';
        const file = Bun.file(join(dir, name));
        return file.size > 0 ? new Response(file) : new Response('not found', { status: 404 });
      },
    });
  }
  get url(): string {
    return `http://127.0.0.1:${this.server.port}/releases/download/server-channel`;
  }
  stop(): void {
    this.server.stop(true);
  }
}
