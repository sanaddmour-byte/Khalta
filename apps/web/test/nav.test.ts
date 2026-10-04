import { capabilitiesOf, ROLES, type Role } from '@khalta/rbac';
import { describe, expect, it } from 'vitest';
import { NAV, visibleNav } from '../src/lib/nav';

// Written by hand from 01-domain.md §10 so the test is independent of the mapping under test.
const EXPECTED: Record<Role, string[]> = {
  admin: [
    'dashboard',
    'studio',
    'library',
    'profiles',
    'insights',
    'savings',
    'materials',
    'prices',
    'plants',
    'rules',
    'imports',
    'settings',
  ],
  qc_manager: [
    'dashboard',
    'studio',
    'library',
    'profiles',
    'insights',
    'savings',
    'materials',
    'prices',
    'rules',
    'imports',
    'settings',
  ],
  qc_engineer: [
    'dashboard',
    'studio',
    'library',
    'profiles',
    'insights',
    'savings',
    'materials',
    'prices',
    'rules',
  ],
  procurement: ['dashboard', 'library', 'savings', 'materials', 'prices'],
  plant_manager: ['dashboard', 'library', 'savings', 'materials', 'prices'],
  sales: ['dashboard', 'library'],
  viewer: ['dashboard', 'library'],
};

describe('role-aware navigation', () => {
  it('lists the twelve sections in spec order', () => {
    expect(NAV.map((n) => n.id)).toEqual([
      'dashboard',
      'studio',
      'library',
      'profiles',
      'insights',
      'savings',
      'materials',
      'prices',
      'plants',
      'rules',
      'imports',
      'settings',
    ]);
  });

  it.each(ROLES)('%s sees exactly the permitted sections', (role) => {
    const caps = capabilitiesOf(role, { salesCanViewCost: false });
    expect(visibleNav(caps).map((n) => n.id)).toEqual(EXPECTED[role]);
  });

  it('sales gains Savings only when the tenant allows cost visibility', () => {
    const on = visibleNav(capabilitiesOf('sales', { salesCanViewCost: true })).map((n) => n.id);
    expect(on).toEqual(['dashboard', 'library', 'savings']);
  });

  it('no section other than the dashboard is visible without capabilities', () => {
    expect(visibleNav([]).map((n) => n.id)).toEqual(['dashboard']);
  });

  it('every section id has English and Arabic names and descriptions', async () => {
    type Locale = {
      nav: Record<string, string>;
      sections: Record<string, { description: string; milestone: string }>;
    };
    const en = (await import('../src/locales/en.json')).default as unknown as Locale;
    const ar = (await import('../src/locales/ar.json')).default as unknown as Locale;
    for (const n of NAV) {
      for (const loc of [en, ar]) {
        expect(loc.nav[n.id], `nav.${n.id}`).toBeTruthy();
        expect(loc.sections[n.id]?.description, `sections.${n.id}.description`).toBeTruthy();
        expect(loc.sections[n.id]?.milestone, `sections.${n.id}.milestone`).toBeTruthy();
      }
    }
  });
});
