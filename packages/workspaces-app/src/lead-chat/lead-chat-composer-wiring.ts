/**
 * What the composer's controls do: add a file by the sheet, by paste or by a
 * drop, open the sheets, and pick a model. The chat's send and listen stay in
 * `lead-chat-mount.ts`, which passes them in.
 *
 * Dragging files over the composer outlines it (`.lc-drag`): an outline takes
 * no room, so nothing moves. A drag that holds no files, such as selected
 * text, is left to the browser.
 */
import type { LeadEffort, LeadModelAlias } from '@claude-workspaces/core/lead-chat';
import { type Attachments, createAttachments } from './lead-chat-attachments.ts';
import type { LeadChatClient } from './lead-chat-client.ts';
import type { Composer } from './lead-chat-composer.ts';

export interface ComposerWiringOpts {
  composer: Composer;
  client: Pick<LeadChatClient, 'uploadFile' | 'pickModel'>;
  /** Redraw the chat. */
  onChange(): void;
  onNotice(text: string): void;
  toggleListening(): void;
}

export interface ComposerWiring {
  attachments: Attachments;
  /** Whether a send has something to carry. */
  sendable(): boolean;
  /** A sheet was open and is now closed. */
  closeSheet(): boolean;
}

const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files');

export function wireComposer(opts: ComposerWiringOpts): ComposerWiring {
  const { composer: c, client } = opts;
  const attachments = createAttachments({
    upload: (f) => client.uploadFile(f),
    onChange: opts.onChange,
    onNotice: opts.onNotice,
  });

  const fromPicker = (input: HTMLInputElement): void => {
    input.addEventListener('change', () => {
      attachments.add(input.files ?? []);
      // The same file can be picked again after it is removed.
      input.value = '';
      c.sheet(null);
    });
  };
  fromPicker(c.camera);
  fromPicker(c.photos);
  fromPicker(c.files);
  c.cameraTile.addEventListener('click', () => c.camera.click());
  c.photosTile.addEventListener('click', () => c.photos.click());
  c.filesTile.addEventListener('click', () => c.files.click());
  c.plus.addEventListener('click', () => c.sheet('add'));
  c.chip.addEventListener('click', () => c.sheet('model'));
  c.scrim.addEventListener('click', () => c.sheet(null));
  for (const close of c.closers) close.addEventListener('click', () => c.sheet(null));
  c.mic.addEventListener('click', () => opts.toggleListening());
  c.tray.addEventListener('click', (e) => {
    const key = (e.target as HTMLElement).dataset?.remove;
    if (key) attachments.remove(key);
  });

  c.field.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) attachments.add(files);
  });

  c.root.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    c.root.classList.add('lc-drag');
  });
  c.root.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  c.root.addEventListener('dragleave', (e) => {
    if (e.relatedTarget instanceof Node && c.root.contains(e.relatedTarget)) return;
    c.root.classList.remove('lc-drag');
  });
  c.root.addEventListener('drop', (e) => {
    c.root.classList.remove('lc-drag');
    if (!hasFiles(e)) return;
    e.preventDefault();
    attachments.add(e.dataTransfer?.files ?? []);
  });

  const pick = async (choice: { model?: LeadModelAlias; effort?: LeadEffort }): Promise<void> => {
    const res = await client.pickModel(choice);
    if (!res.ok) {
      // The chat's status line sits behind the sheet.
      c.sheet(null);
      opts.onNotice(
        res.error === 'owner-proof-required'
          ? 'Sign in as the board’s owner to switch the lead.'
          : 'The lead stays as it is. Check the connection and try again.',
      );
    }
  };
  for (const [model, row] of c.modelRows) {
    row.addEventListener('click', () => void pick({ model }));
  }
  for (const [effort, row] of c.effortRows) {
    row.addEventListener('click', () => void pick({ effort }));
  }

  return {
    attachments,
    sendable: () =>
      attachments.settled() && (attachments.count() > 0 || c.field.value.trim() !== ''),
    closeSheet() {
      if (c.openSheet() === null) return false;
      c.sheet(null);
      return true;
    },
  };
}
