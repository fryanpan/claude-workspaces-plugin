/**
 * A page that is not the board: served by a dev server of its own on another
 * port, it joins one doc's room with the app kit's page client
 * (`app-kit/src/client/sync.ts`) and nothing from the board app. Built by
 * `core-edit-latency-browser-driver.ts`, which reads it back through
 * `window.__outside`.
 *
 * The socket address comes from the page's own `?socket=` parameter.
 */
import * as Y from 'yjs';
import { connectDoc } from '../../app-kit/src/client/sync.ts';

declare global {
  interface Window {
    __outside?: {
      status: () => string;
      text: () => string;
      append: (words: string) => void;
    };
  }
}

const socket = new URL(location.href).searchParams.get('socket') ?? '';
const sync = connectDoc(socket);
const prose = sync.doc.getXmlFragment('prose');

window.__outside = {
  status: () => sync.status(),
  text: () => prose.toString(),
  append: (words) => {
    sync.doc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      t.insert(0, words);
      prose.push([p]);
    });
  },
};
