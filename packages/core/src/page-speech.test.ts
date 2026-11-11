/**
 * A page that speaks with `speechSynthesis` says so to the page holding it,
 * and says when it stops. Driven over a stand-in window and engine on a fake
 * clock: nothing speaks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SPEECH_WATCH_SCRIPT,
  type SpeechWatchWindow,
  installSpeechWatch,
  parseSpeechMessage,
} from './page-speech.ts';

type Listener = () => void;

/** An utterance the stand-in engine can end. */
class Utterance {
  listeners: Record<string, Listener[]> = {};
  constructor(readonly text: string) {}
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }
  fire(type: string): void {
    for (const fn of this.listeners[type] ?? []) fn();
  }
}

/** A window holding a speech engine that speaks until told to stop. */
function standIn(framed: boolean) {
  const posted: unknown[] = [];
  const parent = { postMessage: (m: unknown) => posted.push(m) };
  class SpeechSynthesis {
    speaking = false;
    pending = false;
    current: Utterance | null = null;
    speak(u: Utterance): void {
      this.speaking = true;
      this.current = u;
    }
    cancel(): void {
      this.speaking = false;
    }
    /** The line finished playing. */
    done(): void {
      this.speaking = false;
      this.current?.fire('end');
    }
  }
  const engine = new SpeechSynthesis();
  const win: SpeechWatchWindow & { posted: unknown[] } = {
    posted,
    parent: framed ? parent : null,
    speechSynthesis: engine,
    SpeechSynthesis,
    postMessage: (m: unknown) => posted.push(m),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  if (!framed) win.parent = win;
  return { win, engine, posted };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const said = (posted: unknown[]): boolean[] =>
  posted.map((m) => parseSpeechMessage(m)?.on ?? null).filter((v): v is boolean => v !== null);

describe('a framed page speaking with speechSynthesis', () => {
  it('says it speaks before the engine starts, beats while it does, and says when it stops', () => {
    const { win, engine, posted } = standIn(true);
    installSpeechWatch(win);
    engine.speak(new Utterance('Turn left on Riverbend Road') as never);
    expect(said(posted)).toEqual([true]);
    vi.advanceTimersByTime(1_200);
    // Still speaking: the beat keeps saying so.
    expect(said(posted).length).toBeGreaterThan(1);
    expect(said(posted).every(Boolean)).toBe(true);
    engine.done();
    vi.advanceTimersByTime(100);
    expect(said(posted).at(-1)).toBe(false);
    const count = posted.length;
    vi.advanceTimersByTime(2_000);
    expect(posted.length).toBe(count);
  });

  it('says it stopped when the page cancels the line', () => {
    const { win, engine, posted } = standIn(true);
    installSpeechWatch(win);
    engine.speak(new Utterance('Continue on Harborlight Way') as never);
    engine.cancel();
    vi.advanceTimersByTime(100);
    expect(said(posted)).toEqual([true, false]);
  });

  it('says it stopped when the engine cannot speak the line', () => {
    const { win, engine, posted } = standIn(true);
    installSpeechWatch(win);
    const u = new Utterance('Saltmarsh exit ahead');
    engine.speak(u as never);
    engine.speaking = false;
    u.fire('error');
    vi.advanceTimersByTime(100);
    expect(said(posted)).toEqual([true, false]);
  });

  it('wraps the engine once however often it is installed', () => {
    const { win, engine, posted } = standIn(true);
    installSpeechWatch(win);
    installSpeechWatch(win);
    engine.speak(new Utterance('Harborlight') as never);
    expect(said(posted)).toEqual([true]);
  });

  it('posts to itself at the top of the page', () => {
    const { win, engine, posted } = standIn(false);
    installSpeechWatch(win);
    engine.speak(new Utterance('Riverbend') as never);
    expect(said(posted)).toEqual([true]);
  });

  it('does nothing in a window without a speech engine', () => {
    const { win, engine, posted } = standIn(true);
    win.speechSynthesis = undefined;
    installSpeechWatch(win);
    engine.speak(new Utterance('Riverbend') as never);
    expect(posted).toEqual([]);
  });
});

describe('SPEECH_WATCH_SCRIPT, as the server writes it into a frame', () => {
  it('runs on its own and watches the engine as the function does', () => {
    const { win, engine, posted } = standIn(true);
    new Function('window', SPEECH_WATCH_SCRIPT)(win);
    engine.speak(new Utterance('Turn right on Saltmarsh Lane') as never);
    engine.done();
    vi.advanceTimersByTime(100);
    expect(said(posted)).toEqual([true, false]);
  });
});

describe('parseSpeechMessage', () => {
  it('takes only a speaking message with a boolean', () => {
    expect(parseSpeechMessage({ cw: 'speaking', on: true })).toEqual({ cw: 'speaking', on: true });
    expect(parseSpeechMessage({ cw: 'speaking', on: 'yes' })).toBeNull();
    expect(parseSpeechMessage({ cw: 'here', on: true })).toBeNull();
    expect(parseSpeechMessage(null)).toBeNull();
  });
});
