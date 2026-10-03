import { describe, expect, it } from 'vitest';
import { loadConfig, productionProblems } from '../src/config';

const SECRET = 'q8Zr3vYw1LmN6tKp0XcB5dHs9JfGa2Ue7ViOe4Rn';
const prod = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  DEPLOY_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db.internal:5432/khalta',
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: 'https://khalta.example.org',
  APP_BASE_URL: 'https://khalta.example.org',
  TRUST_PROXY: '1',
  ...over,
});

describe('production configuration guard', () => {
  it('accepts a sound production configuration', () => {
    expect(() => loadConfig(prod())).not.toThrow();
    expect(productionProblems(loadConfig(prod()), prod())).toEqual([]);
  });
  it('refuses each unsafe setting, naming it', () => {
    const cases: [Record<string, string | undefined>, RegExp][] = [
      [{ NODE_ENV: 'development' }, /NODE_ENV must be production/],
      [{ BETTER_AUTH_URL: 'http://khalta.example.org' }, /BETTER_AUTH_URL must be an https/],
      [{ APP_BASE_URL: 'http://khalta.example.org' }, /APP_BASE_URL must be an https/],
      [{ PDF_BASE_URL: 'http://khalta.example.org' }, /PDF_BASE_URL must be an https/],
      [
        { BETTER_AUTH_SECRET: 'dev-secret-change-me-dev-secret-change-me' },
        /BETTER_AUTH_SECRET looks like a placeholder/,
      ],
      [
        { BOOTSTRAP_ADMIN_PASSWORD: 'dev-password-change-me' },
        /BOOTSTRAP_ADMIN_PASSWORD looks like a placeholder/,
      ],
      [{ KHALTA_DEMO: '1' }, /KHALTA_DEMO=1/],
      [{ KHALTA_ALLOW_DEMO_SEED: '1' }, /KHALTA_ALLOW_DEMO_SEED/],
      [{ TRUST_PROXY: '0' }, /TRUST_PROXY must be 1/],
    ];
    for (const [over, re] of cases)
      expect(() => loadConfig(prod(over)), JSON.stringify(over)).toThrow(re);
  });
  it('lists every problem at once', () => {
    try {
      loadConfig(
        prod({ BETTER_AUTH_URL: 'http://x.example.org', TRUST_PROXY: '0', KHALTA_DEMO: '1' }),
      );
      expect.unreachable();
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toMatch(/Unsafe production configuration/);
      expect(m).toMatch(/BETTER_AUTH_URL/);
      expect(m).toMatch(/TRUST_PROXY/);
      expect(m).toMatch(/KHALTA_DEMO/);
    }
  });
  it('staging and development are not held to it (staging still shows the demo banner over http or https)', () => {
    expect(() =>
      loadConfig({
        ...prod(),
        DEPLOY_ENV: 'staging',
        KHALTA_DEMO: '1',
        TRUST_PROXY: '0',
        BETTER_AUTH_URL: 'http://x.example.org',
      }),
    ).not.toThrow();
    expect(() =>
      loadConfig({ ...prod(), DEPLOY_ENV: undefined, NODE_ENV: 'development' }),
    ).not.toThrow();
  });
  it('still fails fast on a missing secret or database', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/Invalid configuration/);
  });
});
