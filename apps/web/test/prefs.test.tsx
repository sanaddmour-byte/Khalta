import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { PrefsProvider, usePrefs } from '../src/lib/prefs';

function Probe() {
  const p = usePrefs();
  return (
    <div>
      <output data-testid="state">{`${p.lang}|${p.dir}|${p.theme}|${p.density}`}</output>
      <button onClick={() => p.setLang(p.lang === 'ar' ? 'en' : 'ar')}>lang</button>
      <button onClick={() => p.setThemePref('dark')}>dark</button>
      <button onClick={() => p.setDensity('comfortable')}>dense</button>
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  const d = document.documentElement;
  d.removeAttribute('data-theme');
  d.lang = 'en';
  d.dir = 'ltr';
});

describe('preferences', () => {
  it('switching language sets lang, dir, remembers it and flips back', async () => {
    const user = userEvent.setup();
    render(
      <PrefsProvider>
        <Probe />
      </PrefsProvider>,
    );
    await user.click(screen.getByText('lang'));
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(window.localStorage.getItem('khalta.lang')).toBe('ar');
    expect(screen.getByTestId('state').textContent).toMatch(/^ar\|rtl\|/);
    await user.click(screen.getByText('lang'));
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('theme and density are applied to the root element and remembered', async () => {
    const user = userEvent.setup();
    render(
      <PrefsProvider>
        <Probe />
      </PrefsProvider>,
    );
    await user.click(screen.getByText('dark'));
    await user.click(screen.getByText('dense'));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.dataset['density']).toBe('comfortable');
    expect(window.localStorage.getItem('khalta.theme')).toBe('dark');
    expect(window.localStorage.getItem('khalta.density')).toBe('comfortable');
  });

  it('keeps working when storage is unavailable (private mode)', async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('blocked');
    };
    try {
      const user = userEvent.setup();
      render(
        <PrefsProvider>
          <Probe />
        </PrefsProvider>,
      );
      await act(async () => {
        await user.click(screen.getByText('lang'));
      });
      expect(document.documentElement.dir).toBe('rtl');
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
