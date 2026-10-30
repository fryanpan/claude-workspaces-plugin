/**
 * Chat first or Voice first: what a tap on the agent button does on this
 * device. Chat first opens the chat with the cursor in its composer; Voice
 * first brings out the bar and starts listening.
 *
 * Per device, never per account (CLAUDE.md, "Width cannot identify a
 * device"): a phone in a pocket and an iPad on a desk want different answers
 * from the same person, so the choice is a stored preference in this
 * browser. Settings writes it (`board-settings-view.ts`'s Voice row); every
 * page reads it at the tap, so a change in another tab applies at the next.
 */

export type LeadChatMode = 'chat' | 'voice';

export const LEAD_CHAT_MODE_KEY = 'cw.lead-chat.mode';

export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Chat first unless this device chose Voice first. A storage that throws
 *  (Safari's private mode) reads as the default. */
export function readLeadChatMode(storage: ModeStorage | null): LeadChatMode {
  try {
    return storage?.getItem(LEAD_CHAT_MODE_KEY) === 'voice' ? 'voice' : 'chat';
  } catch {
    return 'chat';
  }
}

export function writeLeadChatMode(storage: ModeStorage | null, mode: LeadChatMode): void {
  try {
    storage?.setItem(LEAD_CHAT_MODE_KEY, mode);
  } catch {
    // Not stored: the next tap reads the default, which is what it showed.
  }
}

/** `localStorage`, or null where reading it throws. */
export function deviceStorage(): ModeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
