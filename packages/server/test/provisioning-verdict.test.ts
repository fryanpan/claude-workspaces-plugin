/**
 * The Fly app-name rule the provisioning helpers and the keeper share
 * (`provisioning/verdict.ts`), and that the keeper's store still answers
 * with the same rule after it moved.
 */
import { describe, expect, it } from 'bun:test';
import { APP_NAME as STORE_APP_NAME } from '../src/keeper/keeper-store.ts';
import { classifyPushKeys } from '../src/provisioning/push-keys.ts';
import { APP_NAME } from '../src/provisioning/verdict.ts';

describe('APP_NAME', () => {
  it('admits a lower-case Fly app name and refuses anything else', () => {
    expect(APP_NAME.test('cw-harborlight')).toBe(true);
    expect(APP_NAME.test('Cw-Harborlight')).toBe(false);
    expect(APP_NAME.test('9riverbend')).toBe(false);
    expect(APP_NAME.test('a')).toBe(false);
  });

  it('is the one the keeper store re-exports', () => {
    expect(STORE_APP_NAME).toBe(APP_NAME);
  });

  it('is what a push-keys request is refused by', () => {
    const v = classifyPushKeys('Not An App', ['harborlight/riverbend'], ['cw-harborlight']);
    expect(v.kind).toBe('refused');
  });
});
