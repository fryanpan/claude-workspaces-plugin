/**
 * The location prompt appears at most once per device, and only on a board.
 *
 * Driven against a fake browser whose Permissions API state and prompt
 * answer the test sets, across several "page loads" sharing one storage —
 * which is what a device is, as far as this module can tell. The real-browser
 * half (Chrome's own grant and deny, set over CDP) is
 * `device-context-browser.test.ts`.
 *
 * Coordinates are fictional (open ocean).
 */
import { describe, expect, it } from 'vitest';
import { type DeviceContextEnv, GEO_ANSWER_KEY, syncDeviceContext } from '../src/device-context.ts';

type Answer = 'allow' | 'deny' | 'dismiss';

/** One device: its storage and its browser permission outlive a page load. */
function device(initial: { state: string; answer: Answer }) {
  const store = new Map<string, string>();
  const device = { ...initial, prompts: 0, fixes: 0 };
  const cookies: string[] = [];

  function load(): DeviceContextEnv {
    return {
      navigator: {
        maxTouchPoints: 5,
        permissions: { query: async () => ({ state: device.state }) },
        geolocation: {
          getCurrentPosition(ok, fail) {
            if (device.state === 'prompt') {
              device.prompts++;
              if (device.answer === 'allow') device.state = 'granted';
              if (device.answer === 'deny') device.state = 'denied';
            }
            if (device.state === 'granted') {
              device.fixes++;
              ok?.({
                coords: { latitude: 10.123456, longitude: -20.345678 },
              } as GeolocationPosition);
            } else {
              fail?.({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError);
            }
          },
        },
      },
      document: {
        get cookie() {
          return '';
        },
        set cookie(v: string) {
          cookies.push(v);
        },
      },
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
      },
      secure: true,
    };
  }
  const lastGeoCookie = () => [...cookies].reverse().find((c) => c.startsWith('cw_geo='));
  return { device, load, store, cookies, lastGeoCookie };
}

describe('syncDeviceContext', () => {
  it('asks once on the first board load, and a rounded fix goes in the cookie after allow', async () => {
    const d = device({ state: 'prompt', answer: 'allow' });
    expect(await syncDeviceContext(d.load(), { mayAsk: true })).toBe('asked');
    expect(d.device.prompts).toBe(1);
    expect(d.lastGeoCookie()).toMatch(
      /^cw_geo=10\.12,-20\.35; Path=\/; Max-Age=\d+; SameSite=Strict; Secure$/,
    );
    expect(d.store.get(GEO_ANSWER_KEY)).toBe('granted');
    // Later loads refresh silently: no second prompt, a second fix.
    expect(await syncDeviceContext(d.load(), { mayAsk: true })).toBe('refreshed');
    expect(d.device.prompts).toBe(1);
    expect(d.device.fixes).toBe(2);
  });

  it('after a dismiss the prompt never shows again, even though the browser still says prompt', async () => {
    const d = device({ state: 'prompt', answer: 'dismiss' });
    await syncDeviceContext(d.load(), { mayAsk: true });
    expect(d.device.prompts).toBe(1);
    expect(d.store.get(GEO_ANSWER_KEY)).toBe('denied');
    expect(d.lastGeoCookie()).toMatch(/^cw_geo=; Path=\/; Max-Age=0/);
    for (let i = 0; i < 3; i++) {
      expect(await syncDeviceContext(d.load(), { mayAsk: true })).toBe('unchanged');
    }
    expect(d.device.state).toBe('prompt');
    expect(d.device.prompts).toBe(1);
  });

  it('after a deny nothing is asked and no location is written', async () => {
    const d = device({ state: 'prompt', answer: 'deny' });
    await syncDeviceContext(d.load(), { mayAsk: true });
    expect(await syncDeviceContext(d.load(), { mayAsk: true })).toBe('cleared');
    expect(d.device.prompts).toBe(1);
    expect(d.cookies.some((c) => /^cw_geo=\d/.test(c))).toBe(false);
  });

  it('a document page never asks, but writes the touch hint', async () => {
    const d = device({ state: 'prompt', answer: 'allow' });
    expect(await syncDeviceContext(d.load(), { mayAsk: false })).toBe('unchanged');
    expect(d.device.prompts).toBe(0);
    expect(d.store.has(GEO_ANSWER_KEY)).toBe(false);
    expect(d.cookies[0]).toMatch(/^cw_touch=5; /);
    // Positive control: the board, on the same device, does ask.
    expect(await syncDeviceContext(d.load(), { mayAsk: true })).toBe('asked');
    expect(d.device.prompts).toBe(1);
  });

  it('a grant made later in the browser settings is honoured without a prompt', async () => {
    const d = device({ state: 'prompt', answer: 'dismiss' });
    await syncDeviceContext(d.load(), { mayAsk: true });
    d.device.state = 'granted';
    expect(await syncDeviceContext(d.load(), { mayAsk: false })).toBe('refreshed');
    expect(d.device.prompts).toBe(1);
    expect(d.lastGeoCookie()).toMatch(/^cw_geo=10\.12,-20\.35;/);
  });

  it('a page with no geolocation still boots and writes the touch hint', async () => {
    const d = device({ state: 'prompt', answer: 'allow' });
    const env = d.load();
    env.navigator.geolocation = undefined;
    expect(await syncDeviceContext(env, { mayAsk: true })).toBe('unchanged');
    expect(d.cookies).toHaveLength(1);
  });
});
