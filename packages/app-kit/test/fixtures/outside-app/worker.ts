import {
  type DurableRoom,
  type HibernatingSocket,
  alarmSchedule,
  createDurableRoom,
  sqlKeyValue,
} from '@claude-workspaces/app-kit/do';
import { type MarkdownFileRoom, markdownFileRoom } from '@claude-workspaces/app-kit/markdown-file';
/**
 * A Worker app outside this repo, as `outside-app.test.ts` installs it: one
 * Durable Object per markdown file, through `./do` and `./markdown-file`
 * from the packed kit. The test typechecks it with a plain tsconfig (no DOM
 * lib, no `allowImportingTsExtensions`) and bundles it for workerd.
 */
import type { DurableObjectState } from '@cloudflare/workers-types';

type Socket = HibernatingSocket & { readonly readyState: number };

export class HarborlightDoc {
  private file!: MarkdownFileRoom;
  private room!: DurableRoom<Socket>;

  constructor(ctx: DurableObjectState) {
    const sockets = ctx as unknown as {
      acceptWebSocket(ws: Socket): void;
      getWebSockets(): Socket[];
    };
    void ctx.blockConcurrencyWhile(async () => {
      this.file = await markdownFileRoom({
        load: async () => '# Harborlight\n',
        save: async () => {},
        state: sqlKeyValue(ctx.storage.sql, 'file'),
        schedule: alarmSchedule(ctx.storage),
        onConflict: async () => {},
      });
      this.room = createDurableRoom({ ctx: sockets, docs: this.file.docs });
    });
  }

  async alarm(): Promise<void> {
    await this.file.flush();
  }

  async fetch(): Promise<Response> {
    this.room.flush();
    return new Response(this.file.text());
  }
}

export default {
  fetch: (): Response => new Response('Harborlight'),
};
