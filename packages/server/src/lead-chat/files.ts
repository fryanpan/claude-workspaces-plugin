/**
 * The photos and files people send a board's lead, stored under the board:
 * `<dataDir>/workspaces/<board>.lead-chat-files/<id>` with `<id>.json` beside
 * it holding what the server decided about the bytes.
 *
 * Nothing the browser says is kept as fact. The id is the server's. The name
 * is reduced to a label: no folders, no control characters, and it is never
 * part of a path. `image` and `type` come from the bytes (`sniffImage`), so a
 * script named `photo.png` is stored as an opaque file and served as a
 * download. Files are written with `wx`, so nothing is overwritten, and are
 * readable by this user alone.
 *
 * A board's folder is only ever named from a board id the route already holds
 * (`leadChatLogPath`'s rule), and an id must match `LEAD_CHAT_FILE_ID` before
 * it reaches a path.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEAD_CHAT_FILE_ID,
  type LeadChatAttachment,
  parseLeadChatAttachment,
} from '@claude-workspaces/core/lead-chat';
import { type ImageExt, sniffImage } from '../doc-image-store.ts';
import { leadChatLogPath } from './log.ts';

const IMAGE_TYPE: Record<ImageExt, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** What a stored file that is not a raster image is called. */
export const OPAQUE_FILE_TYPE = 'application/octet-stream';
const NAME_MAX = 120;

/** A label for what a browser called the file. */
export function fileLabel(name: string | null | undefined): string {
  const base = (name ?? '').split(/[/\\]/).pop() ?? '';
  const clean = base.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim();
  if (clean === '' || clean === '.' || clean === '..') return 'file';
  return clean.length <= NAME_MAX ? clean : clean.slice(-NAME_MAX);
}

export class LeadChatFiles {
  constructor(
    private readonly dataDir: string,
    private readonly newId: () => string,
  ) {}

  /** The board's folder, or null for an id that cannot name one. */
  private folder(workspaceId: string): string | null {
    const log = leadChatLogPath(this.dataDir, workspaceId);
    return log ? log.replace(/\.lead-chat\.jsonl$/, '.lead-chat-files') : null;
  }

  /** Store the bytes; null when the board's folder cannot be written. */
  save(workspaceId: string, bytes: Uint8Array, name: string | null): LeadChatAttachment | null {
    const dir = this.folder(workspaceId);
    if (!dir) return null;
    const ext = sniffImage(bytes);
    const file: LeadChatAttachment = {
      id: this.newId(),
      name: fileLabel(name),
      type: ext ? IMAGE_TYPE[ext] : OPAQUE_FILE_TYPE,
      size: bytes.byteLength,
      ...(ext ? { image: true as const } : {}),
    };
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, file.id), bytes, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(dir, `${file.id}.json`), JSON.stringify(file), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (err) {
      console.error(`[lead-chat] could not store a file on ${workspaceId}: ${String(err)}`);
      return null;
    }
    return file;
  }

  /** What is stored under `id` on this board, or null. */
  get(workspaceId: string, id: string): LeadChatAttachment | null {
    const path = this.pathOf(workspaceId, id);
    if (!path) return null;
    try {
      return parseLeadChatAttachment(JSON.parse(readFileSync(`${path}.json`, 'utf8')));
    } catch {
      return null;
    }
  }

  /** The bytes' path, when `id` is an id and a file on this board holds it. */
  pathOf(workspaceId: string, id: string): string | null {
    const dir = this.folder(workspaceId);
    if (!dir || !LEAD_CHAT_FILE_ID.test(id)) return null;
    const path = join(dir, id);
    try {
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
    }
  }
}
