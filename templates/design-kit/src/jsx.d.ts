// The kit's custom elements in Preact JSX. Loose on purpose: the trial needs
// the tags to typecheck, not a full per-component attribute model.
import type { JSX } from 'preact';

type WaProps = JSX.HTMLAttributes<HTMLElement> & Record<string, unknown>;

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'wa-badge': WaProps;
      'wa-button': WaProps;
      'wa-card': WaProps;
      'wa-input': WaProps;
      'wa-popover': WaProps;
      'wa-tag': WaProps;
    }
  }
}
