/**
 * @vitest-environment happy-dom
 *
 * The JSX runtime a component bundle carries: JSX builds DOM at once, a
 * function tag is mounted into an element of its own with its children as
 * nodes, a built-in is drawn by the page, and text never reaches the DOM as
 * HTML. Driven through the same `jsx()` calls esbuild's automatic runtime
 * emits for `<Ferry route="Harborlight"><b>Riverbend</b></Ferry>`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type ComponentHostApi,
  Fragment,
  type MountFn,
  type StateHook,
  builtin,
  jsx,
  jsxs,
  render,
} from './mdx-component-runtime.ts';

const NO_BUILTINS: ComponentHostApi = { builtins: {} };

describe('the component JSX runtime', () => {
  it('builds an element with its attributes, style, listeners and ref', () => {
    const clicked = vi.fn();
    let seen: Element | null = null;
    const el = jsxs('a', {
      className: 'ferry',
      htmlFor: 'route',
      title: 'Harborlight',
      tabIndex: 0,
      hidden: false,
      draggable: true,
      style: { color: 'red' },
      onClick: clicked,
      ref: (n: Element) => {
        seen = n;
      },
      children: ['Saltmarsh ', 3],
    }) as HTMLElement;
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('class')).toBe('ferry');
    expect(el.getAttribute('for')).toBe('route');
    expect(el.getAttribute('tabIndex')).toBe('0');
    expect(el.hasAttribute('hidden')).toBe(false);
    expect(el.getAttribute('draggable')).toBe('');
    expect(el.style.color).toBe('red');
    expect(el.textContent).toBe('Saltmarsh 3');
    el.dispatchEvent(new Event('click'));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(seen).toBe(el);
  });

  it('hands an object prop to a property, so a custom element reads its data', () => {
    const rows = [{ year: 2020, n: 4 }];
    const el = jsx('hl-chart', { rows }) as HTMLElement & { rows?: unknown };
    expect(el.rows).toBe(rows);
    expect(el.hasAttribute('rows')).toBe(false);
  });

  it('never parses text or an innerHTML prop as HTML', () => {
    const el = jsx('div', {
      // An array would go to the property of that name, which parses it.
      innerHTML: ['<img src=x onerror=alert(1)>'],
      outerHTML: ['<img src=x>'],
      dangerouslySetInnerHTML: { __html: '<b>no</b>' },
      children: '<i>Alice</i>',
    }) as HTMLElement;
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe('<i>Alice</i>');
  });

  it('mounts a function tag with its children built, and render cleans it up', () => {
    const cleaned: string[] = [];
    const Carousel: MountFn = (el, props) => {
      for (const child of props.children as Node[]) {
        const slide = document.createElement('section');
        slide.append(child);
        el.append(slide);
      }
      return () => cleaned.push(String(props.label));
    };
    const host = document.createElement('div');
    host.textContent = 'old';
    const stop = render(host, NO_BUILTINS, () =>
      jsxs(Carousel, {
        label: 'Bob',
        children: [jsx('b', { children: 'one' }), jsx('b', { children: 'two' }), null, false],
      }),
    );
    const mount = host.querySelector('.mdx-component');
    expect(host.childNodes).toHaveLength(1);
    expect(mount?.querySelectorAll('section > b')).toHaveLength(2);
    expect(cleaned).toEqual([]);
    stop();
    expect(cleaned).toEqual(['Bob']);
    stop();
    expect(cleaned).toEqual(['Bob']);
  });

  it('draws a built-in through the page, and says so outside a doc', () => {
    const draw = vi.fn((el: HTMLElement, props: Record<string, unknown>) => {
      el.textContent = `chart ${String(props.subtitle)}`;
    });
    const host = document.createElement('div');
    render(host, { builtins: { PlotChart: draw } }, () =>
      jsx(builtin('PlotChart'), { subtitle: 'Riverbend' }),
    );
    expect(host.querySelector('.mdx-builtin')?.textContent).toBe('chart Riverbend');
    expect(draw).toHaveBeenCalledTimes(1);
    const loose = jsx(builtin('PlotChart'), {}) as HTMLElement;
    expect(loose.textContent).toBe('<PlotChart> is drawn only in a doc');
  });

  it('flattens a fragment, and a cleanup that throws does not stop the rest', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran: string[] = [];
    const Bad: MountFn = () => () => {
      throw new Error('boom');
    };
    const Good: MountFn = () => () => ran.push('good');
    const host = document.createElement('div');
    const stop = render(host, NO_BUILTINS, () =>
      jsxs(Fragment, { children: [jsx(Bad, {}), jsx(Good, {}), 'tail'] }),
    );
    expect(host.childNodes).toHaveLength(3);
    stop();
    expect(ran).toEqual(['good']);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('hands a tag with an id the state the page has for that id, and no state without one', () => {
    const asked: string[] = [];
    const hook = { canWrite: true } as unknown as StateHook;
    const api: ComponentHostApi = {
      builtins: {},
      state: (id) => {
        asked.push(id);
        return hook;
      },
    };
    const got: unknown[] = [];
    const Map: MountFn = (_el, _props, state) => {
      got.push(state);
    };
    render(document.createElement('div'), api, () =>
      jsxs(Fragment, { children: [jsx(Map, { id: 'harborlight' }), jsx(Map, {})] }),
    );
    expect(asked).toEqual(['harborlight']);
    expect(got).toEqual([hook, undefined]);
  });
});
