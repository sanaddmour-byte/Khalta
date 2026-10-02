import { describe, expect, it } from 'vitest';
import {
  assertNotAuthor,
  canAccessPlant,
  CAPABILITIES,
  capabilitiesOf,
  FourEyesViolation,
  isPlantScoped,
  isRole,
  ROLES,
  roleCan,
  type Capability,
  type Role,
} from '../src/index';

// Independent transcription of 01-domain.md §10 (the spec table), role -> capabilities.
// 'S' marks the sales cost capability that depends on the tenant setting.
const SPEC: Record<Role, Capability[]> = {
  admin: [
    'org.manage',
    'price.view',
    'price.edit',
    'cost.view',
    'library.read',
    'import.run',
    'export.priceCost',
    'audit.read',
    'rules.read',
    'materials.read',
  ],
  qc_manager: [
    'price.view',
    'cost.view',
    'design.write',
    'trial.request',
    'lab.enter',
    'trial.pass',
    'design.approve',
    'rules.read',
    'rules.verify',
    'design.attest',
    'baseline.create',
    'profile.approve',
    'candidate.authorize',
    'production.release',
    'insight.accept',
    'insight.draft',
    'library.read',
    'import.run',
    'export.priceCost',
    'audit.read',
    'materials.read',
    'materials.write',
    'suppliers.write',
  ],
  qc_engineer: [
    'price.view',
    'cost.view',
    'design.write',
    'trial.request',
    'lab.enter',
    'insight.draft',
    'library.read',
    'rules.read',
    'materials.read',
    'materials.write',
    'suppliers.write',
  ],
  procurement: [
    'price.view',
    'price.edit',
    'cost.view',
    'library.read',
    'export.priceCost',
    'materials.read',
    'suppliers.write',
  ],
  plant_manager: [
    'price.view',
    'cost.view',
    'lab.enter',
    'production.release',
    'library.read',
    'materials.read',
  ],
  sales: ['library.read'],
  viewer: ['library.read'],
};

describe('role x capability matrix', () => {
  for (const role of ROLES) {
    for (const cap of CAPABILITIES) {
      it(`${role} ${SPEC[role].includes(cap) ? 'can' : 'cannot'} ${cap}`, () => {
        expect(roleCan(role, cap, { salesCanViewCost: false })).toBe(SPEC[role].includes(cap));
      });
    }
  }

  it('sales sees cost only when the tenant setting is on', () => {
    expect(roleCan('sales', 'cost.view', { salesCanViewCost: false })).toBe(false);
    expect(roleCan('sales', 'cost.view', { salesCanViewCost: true })).toBe(true);
    expect(capabilitiesOf('sales', { salesCanViewCost: true })).toContain('cost.view');
  });

  it('the setting does not widen any other role', () => {
    for (const role of ROLES.filter((r) => r !== 'sales'))
      expect(capabilitiesOf(role, { salesCanViewCost: true })).toEqual(
        capabilitiesOf(role, { salesCanViewCost: false }),
      );
  });

  it('only QC Manager can approve, attest, baseline, verify rules and mark trials passed', () => {
    for (const cap of [
      'design.approve',
      'design.attest',
      'baseline.create',
      'profile.approve',
      'candidate.authorize',
      'rules.verify',
      'trial.pass',
    ] as const)
      expect(ROLES.filter((r) => roleCan(r, cap, { salesCanViewCost: true }))).toEqual([
        'qc_manager',
      ]);
  });
});

describe('scope and guards', () => {
  it('only admin and qc_manager are unscoped', () => {
    expect(ROLES.filter((r) => !isPlantScoped(r))).toEqual(['admin', 'qc_manager']);
  });

  it('canAccessPlant', () => {
    expect(canAccessPlant({ all: true, plantIds: [] }, 'p1')).toBe(true);
    expect(canAccessPlant({ all: false, plantIds: ['p1'] }, 'p1')).toBe(true);
    expect(canAccessPlant({ all: false, plantIds: ['p1'] }, 'p2')).toBe(false);
  });

  it('isRole', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('root')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });

  it('four-eyes blocks the author and unknown authors', () => {
    expect(() => assertNotAuthor('u1', 'u1')).toThrow(FourEyesViolation);
    expect(() => assertNotAuthor('u1', null)).toThrow(FourEyesViolation);
    expect(() => assertNotAuthor('u1', 'u2')).not.toThrow();
  });
});
