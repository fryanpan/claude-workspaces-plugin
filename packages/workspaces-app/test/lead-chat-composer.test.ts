/**
 * The composer: what adds a file, what a send may carry, what a drag does,
 * and what the model chip says. Driven on the real DOM; the network is a fake.
 */
import {
  LEAD_CHAT_FILES_PER_MESSAGE,
  LEAD_CHAT_FILE_MAX_BYTES,
  type LeadChatAttachment,
} from '@claude-workspaces/core/lead-chat';
import { describe, expect, it, vi } from 'vitest';
import { sizeLabel } from '../src/lead-chat/lead-chat-attachments.ts';
import type { ModelPickResult, UploadResult } from '../src/lead-chat/lead-chat-client.ts';
import { wireComposer } from '../src/lead-chat/lead-chat-composer-wiring.ts';
import { chipLabels, createComposer } from '../src/lead-chat/lead-chat-composer.ts';

const url = { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() };
vi.stubGlobal('URL', Object.assign(URL, url));

const png = (name = 'berth.png', size = 12) =>
  new File([new Uint8Array(size)], name, { type: 'image/png' });

const stored = (id: string, f: File): LeadChatAttachment => ({
  id,
  name: f.name,
  type: f.type,
  size: f.size,
  image: true,
});

function setup(
  upload: (f: File) => Promise<UploadResult> = async (f) => ({
    ok: true,
    file: stored(`lf-${f.name}`, f),
  }),
  pickModel: (p: unknown) => Promise<ModelPickResult> = async () => ({ ok: true }),
) {
  const c = createComposer(document);
  document.body.append(c.root, ...c.overlays);
  const notices: string[] = [];
  const picks: unknown[] = [];
  const uploads: string[] = [];
  const listening = vi.fn();
  const wiring = wireComposer({
    composer: c,
    client: {
      uploadFile: (f) => {
        uploads.push(f.name);
        return upload(f);
      },
      pickModel: (p) => {
        picks.push(p);
        return pickModel(p);
      },
    },
    onChange: () =>
      c.render({
        files: wiring.attachments.list(),
        sendable: wiring.sendable(),
        listening: false,
        inMeeting: false,
        leadModel: {},
      }),
    onNotice: (t) => notices.push(t),
    toggleListening: listening,
  });
  return { c, wiring, notices, picks, uploads, listening };
}

/** A settled microtask queue: each fake upload resolves on it. */
const flush = () => vi.waitFor(() => Promise.resolve());

function dragEvent(type: string, files: File[], types = ['Files']) {
  const e = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(e, 'dataTransfer', { value: { types, files, dropEffect: 'none' } });
  return e;
}

describe('adding files', () => {
  it('uploads as a file is added, and a send can carry it with no words', async () => {
    const { c, wiring } = setup();
    let release: (r: UploadResult) => void = () => {};
    const slow = setup(() => new Promise((r) => (release = r)));
    slow.wiring.attachments.add([png()]);
    expect(slow.wiring.sendable()).toBe(false);
    release({ ok: true, file: stored('lf-1', png()) });
    await vi.waitFor(() => expect(slow.wiring.sendable()).toBe(true));
    expect(slow.wiring.attachments.ids()).toEqual(['lf-1']);

    expect(wiring.sendable()).toBe(false);
    c.field.value = 'hello';
    expect(wiring.sendable()).toBe(true);
  });

  it('refuses a file over the limit without uploading it, and names it', () => {
    const { wiring, notices, uploads } = setup();
    const big = new File([new Uint8Array(0)], 'huge.mov');
    Object.defineProperty(big, 'size', { value: LEAD_CHAT_FILE_MAX_BYTES + 1 });
    wiring.attachments.add([big]);
    expect(uploads).toEqual([]);
    expect(wiring.attachments.count()).toBe(0);
    expect(notices).toEqual(['huge.mov is over the 25 MB limit.']);
  });

  it('holds no more than a message can carry', () => {
    const { wiring, notices } = setup();
    const many = Array.from({ length: LEAD_CHAT_FILES_PER_MESSAGE + 2 }, (_, i) => png(`${i}.png`));
    wiring.attachments.add(many);
    expect(wiring.attachments.count()).toBe(LEAD_CHAT_FILES_PER_MESSAGE);
    expect(notices).toHaveLength(1);
  });

  it('takes a file out of the tray when its upload fails, and says so', async () => {
    const { wiring, notices } = setup(async () => ({ ok: false, error: 'offline' }));
    wiring.attachments.add([png()]);
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(wiring.attachments.count()).toBe(0);
  });

  it('adds a pasted image, from the field', async () => {
    const { c, uploads } = setup();
    const e = new Event('paste', { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(e, 'clipboardData', { value: { files: [png('shot.png')] } });
    c.field.dispatchEvent(e);
    expect(uploads).toEqual(['shot.png']);
  });

  it('removes a file by its chip', async () => {
    const { c, wiring } = setup();
    wiring.attachments.add([png()]);
    await flush();
    const x = c.tray.querySelector<HTMLButtonElement>('.lc-att-x');
    x?.click();
    expect(wiring.attachments.count()).toBe(0);
    expect(c.tray.hidden).toBe(true);
  });
});

describe('dragging', () => {
  it('outlines for files, attaches a drop, and clears', () => {
    const { c, uploads } = setup();
    c.root.dispatchEvent(dragEvent('dragenter', []));
    expect(c.root.classList.contains('lc-drag')).toBe(true);
    const drop = dragEvent('drop', [png('a.png'), png('b.png')]);
    c.root.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(uploads).toEqual(['a.png', 'b.png']);
    expect(c.root.classList.contains('lc-drag')).toBe(false);
  });

  it('leaves a drag of selected text to the browser', () => {
    const { c, uploads } = setup();
    const enter = dragEvent('dragenter', [], ['text/plain']);
    c.root.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(c.root.classList.contains('lc-drag')).toBe(false);
    c.root.dispatchEvent(dragEvent('drop', [], ['text/plain']));
    expect(uploads).toEqual([]);
  });
});

describe('the model chip', () => {
  it('shows what the lead runs on, or the pick on its way', () => {
    expect(chipLabels({ model: 'claude-fable-5-1', effort: 'xhigh' })).toEqual({
      model: 'Fable 5.1',
      effort: 'X-high',
    });
    expect(chipLabels({ model: 'opus', pending: { model: 'haiku' } }).model).toBe('Haiku 5.5');
    expect(chipLabels({})).toEqual({ model: 'Model', effort: '' });
  });

  it('opens the sheet, and a tap picks only that value', async () => {
    const { c, picks } = setup();
    c.chip.click();
    expect(c.openSheet()).toBe('model');
    c.modelRows.get('sonnet')?.click();
    c.effortRows.get('low')?.click();
    expect(picks).toEqual([{ model: 'sonnet' }, { effort: 'low' }]);
  });

  it('says so when the page is not the owner’s', async () => {
    const { c, notices } = setup(undefined, async () => ({
      ok: false,
      error: 'owner-proof-required',
    }));
    c.effortRows.get('low')?.click();
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]).toContain('owner');
  });

  it('a scrim tap closes the sheet, and the sheet closes before the chat does', () => {
    const { c, wiring } = setup();
    c.plus.click();
    expect(c.openSheet()).toBe('add');
    c.scrim.click();
    expect(c.openSheet()).toBeNull();
    expect(wiring.closeSheet()).toBe(false);
    c.plus.click();
    expect(wiring.closeSheet()).toBe(true);
  });
});

describe('sizeLabel', () => {
  it('reads as a person would say it', () => {
    expect(sizeLabel(900)).toBe('900 B');
    expect(sizeLabel(2048)).toBe('2 KB');
    expect(sizeLabel(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
