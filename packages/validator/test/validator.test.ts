import { describe, expect, it } from 'vitest';
import { VALIDATOR_API_VERSION } from '../src/index';

describe('validator scaffold', () => {
  it('exposes api version', () => {
    expect(VALIDATOR_API_VERSION).toBe(1);
  });
});
