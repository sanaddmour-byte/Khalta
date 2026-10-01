import { describe, expect, it } from 'vitest';
import { ENGINE_API_VERSION } from '../src/index';
import { OPTIMIZER_API_VERSION } from '../src/optimizer/index';

describe('engine scaffold', () => {
  it('exposes api versions', () => {
    expect(ENGINE_API_VERSION).toBe(1);
    expect(OPTIMIZER_API_VERSION).toBe(1);
  });
});
