import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_LABELS, mountVoiceLoader } from '../src/voice/voice-loader.ts';
import type { WidgetMic } from '../src/widget-mic.ts';

/**
 * The mic on a mock page, which fetches voice feedback on its first tap.
 *
 * happy-dom cannot load a script, so the `<script>` the loader appends is
 * caught on its way into `<head>` and the test plays the network: it says the
 * chunk loaded (having put `window.cwVoice` there, as `voice.js` does) or that
 * it failed.
 */

const SRC = 'http://host:8787/widget/voice.js';

function mockPage(): HTMLElement {
  const host = document.createElement('claude-feedback-widget');
  const shadow = host.attachShadow({ mode: 'open' });
  for (const cls of ['fab-list', 'fab']) {
    const b = document.createElement('button');
    b.className = cls;
    shadow.append(b);
  }
  document.body.append(host);
  Object.assign(host, { shadow });
  return host;
}

let scripts: HTMLScriptElement[] = [];

beforeEach(() => {
  scripts = [];
  vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    for (const n of nodes) if (n instanceof HTMLScriptElement) scripts.push(n);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  window.cwVoice = undefined;
  document.body.innerHTML = '';
});

/** What `voice.js` hands the page, recorded. */
function chunk() {
  const toggle = vi.fn();
  const mountVoiceMode = vi.fn(() => ({ toggle }));
  return { toggle, mountVoiceMode };
}

describe('the mock page’s mic', () => {
  it('puts the mic on the widget with the mock’s own words', () => {
    const host = mockPage();
    const mic = mountVoiceLoader(document, SRC) as WidgetMic;
    expect(mic.button.isConnected).toBe(true);
    const shadow = (host as unknown as { shadow: ShadowRoot }).shadow;
    expect(mic.button.dataset.tip).toBe(MOCK_LABELS.voice);
    expect((shadow.querySelector('.fab') as HTMLElement).dataset.tip).toBe(MOCK_LABELS.comment);
    expect((shadow.querySelector('.fab-list.side') as HTMLElement).dataset.tip).toBe(
      MOCK_LABELS.history,
    );
    expect(scripts, 'nothing is fetched until the mic is tapped').toHaveLength(0);
  });

  it('puts nothing up on a page whose widget has no buttons', () => {
    const host = document.createElement('claude-feedback-widget');
    Object.assign(host, { shadow: host.attachShadow({ mode: 'open' }) });
    document.body.append(host);
    expect(mountVoiceLoader(document, SRC)).toBeNull();
  });

  it('fetches voice feedback once on the first tap, and starts recording when it arrives', async () => {
    mockPage();
    const mic = mountVoiceLoader(document, SRC) as WidgetMic;
    mic.button.click();
    mic.button.click();
    expect(scripts, 'a second tap while it loads fetches nothing more').toHaveLength(1);
    expect(scripts[0]?.src).toBe(SRC);
    expect(mic.button.classList.contains('voice-active'), 'it looks pressed at once').toBe(true);

    const c = chunk();
    window.cwVoice = c as unknown as NonNullable<typeof window.cwVoice>;
    scripts[0]?.onload?.(new Event('load'));
    await vi.waitFor(() => expect(c.toggle).toHaveBeenCalledTimes(1));
    const host = document.querySelector('claude-feedback-widget');
    expect(c.mountVoiceMode).toHaveBeenCalledWith(host, mic);
  });

  it('says so when the fetch fails, and tries again on the next tap', async () => {
    mockPage();
    const mic = mountVoiceLoader(document, SRC) as WidgetMic;
    mic.button.click();
    scripts[0]?.onerror?.(new Event('error'));
    await vi.waitFor(() =>
      expect(mic.readout.textContent).toBe('Voice feedback could not load. Try again.'),
    );
    expect(mic.readout.classList.contains('hidden')).toBe(false);
    expect(mic.button.classList.contains('voice-active')).toBe(false);

    mic.button.click();
    expect(scripts, 'the retry fetches it again').toHaveLength(2);
    const c = chunk();
    window.cwVoice = c as unknown as NonNullable<typeof window.cwVoice>;
    scripts[1]?.onload?.(new Event('load'));
    await vi.waitFor(() => expect(c.toggle).toHaveBeenCalledTimes(1));
  });

  it('treats a script that loaded without voice feedback in it as a failure', async () => {
    mockPage();
    const mic = mountVoiceLoader(document, SRC) as WidgetMic;
    mic.button.click();
    scripts[0]?.onload?.(new Event('load'));
    await vi.waitFor(() =>
      expect(mic.readout.textContent).toBe('Voice feedback could not load. Try again.'),
    );
  });
});
