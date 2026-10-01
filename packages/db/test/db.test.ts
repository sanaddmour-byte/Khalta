import { expect, it } from 'vitest';
import { DB_PACKAGE } from '../src/index';

it('scaffold loads', () => {
  expect(DB_PACKAGE).toBe('db');
});
