import { expect, it } from 'vitest';
import { UI_PACKAGE } from '../src/index';

it('scaffold loads', () => {
  expect(UI_PACKAGE).toBe('ui');
});
