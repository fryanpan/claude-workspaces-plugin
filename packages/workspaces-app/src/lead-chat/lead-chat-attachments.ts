/**
 * The files a person has added to a message and not yet sent. Each goes up as
 * soon as it is added, so a send carries ids and never waits on bytes it could
 * have sent already. A file over the limit never goes up: the reader is told
 * at once, and the server refuses it anyway.
 */
import {
  LEAD_CHAT_FILES_PER_MESSAGE,
  LEAD_CHAT_FILE_MAX_BYTES,
  type LeadChatAttachment,
} from '@claude-workspaces/core/lead-chat';
import type { UploadResult } from './lead-chat-client.ts';
import type { TrayFile } from './lead-chat-composer.ts';

export interface AttachmentsOpts {
  upload(file: File): Promise<UploadResult>;
  onChange(): void;
  /** Something a person should read: a file left out, and why. */
  onNotice(text: string): void;
  url?: { createObjectURL(f: File): string; revokeObjectURL(u: string): void };
}

interface Held extends TrayFile {
  stored?: LeadChatAttachment;
}

const MB = 1024 * 1024;

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

export interface Attachments {
  add(files: Iterable<File>): void;
  remove(key: string): void;
  /** The tray, in the order added. */
  list(): readonly TrayFile[];
  ids(): string[];
  /** Nothing is still going up. */
  settled(): boolean;
  count(): number;
  clear(): void;
}

export function createAttachments(opts: AttachmentsOpts): Attachments {
  const url = opts.url ?? URL;
  let held: Held[] = [];
  let seq = 0;

  const release = (f: Held): void => {
    if (f.preview) url.revokeObjectURL(f.preview);
  };
  const remove = (key: string): void => {
    const f = held.find((h) => h.key === key);
    if (!f) return;
    release(f);
    held = held.filter((h) => h !== f);
    opts.onChange();
  };

  const putUp = async (file: File, entry: Held): Promise<void> => {
    const res = await opts.upload(file);
    if (!held.includes(entry)) return;
    if (res.ok) {
      entry.stored = res.file;
      entry.note = sizeLabel(res.file.size);
      entry.uploading = false;
      opts.onChange();
      return;
    }
    remove(entry.key);
    opts.onNotice(
      res.error === 'file-too-large'
        ? `${file.name} is over the ${LEAD_CHAT_FILE_MAX_BYTES / MB} MB limit.`
        : `${file.name} didn’t upload. Check the connection and try again.`,
    );
  };

  return {
    add(files) {
      for (const file of files) {
        if (held.length >= LEAD_CHAT_FILES_PER_MESSAGE) {
          opts.onNotice(`A message holds ${LEAD_CHAT_FILES_PER_MESSAGE} files at most.`);
          break;
        }
        if (file.size > LEAD_CHAT_FILE_MAX_BYTES) {
          opts.onNotice(`${file.name} is over the ${LEAD_CHAT_FILE_MAX_BYTES / MB} MB limit.`);
          continue;
        }
        if (file.size === 0) {
          opts.onNotice(`${file.name} is empty.`);
          continue;
        }
        seq += 1;
        const entry: Held = {
          key: `f${seq}`,
          name: file.name || 'Pasted image',
          note: 'Uploading',
          uploading: true,
          ...(file.type.startsWith('image/') ? { preview: url.createObjectURL(file) } : {}),
        };
        held = [...held, entry];
        void putUp(file, entry);
      }
      opts.onChange();
    },
    remove,
    list: () => held,
    ids: () => held.flatMap((h) => (h.stored ? [h.stored.id] : [])),
    settled: () => held.every((h) => h.stored),
    count: () => held.length,
    clear() {
      for (const f of held) release(f);
      held = [];
      opts.onChange();
    },
  };
}
