// Single source of truth for roles and capabilities (01-domain.md §10). Pure, dependency-free so
// the API enforces it and the web app can hide what a role cannot see.

export const ROLES = [
  'admin',
  'qc_manager',
  'qc_engineer',
  'procurement',
  'plant_manager',
  'sales',
  'viewer',
] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  'org.manage', // users, plants, settings
  'price.view',
  'price.edit',
  'cost.view',
  'design.write', // create/edit drafts, run evaluate and design
  'trial.request',
  'lab.enter', // material tests, trial batches, strength results
  'trial.pass',
  'design.approve',
  'rules.read',
  'rules.verify',
  'design.attest',
  'production.release', // release to / suspend in production
  'insight.accept',
  'insight.draft', // create a trial-only draft from an insight
  'library.read',
  'materials.read',
  'materials.write', // material records and their tests (plant managers: own plants, via lab.enter)
  'suppliers.write',
  'import.run', // legacy designs, JS rule values
  'export.priceCost',
  'audit.read',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Settings the matrix can depend on. */
export interface RbacSettings {
  salesCanViewCost: boolean;
}

type Cell = boolean | 'setting:salesCanViewCost';

const ALL: Cell = true;
const NO: Cell = false;

const MATRIX: Record<Capability, Record<Role, Cell>> = {
  'org.manage': row({ admin: ALL }),
  'price.view': row({
    admin: ALL,
    qc_manager: ALL,
    qc_engineer: ALL,
    procurement: ALL,
    plant_manager: ALL,
  }),
  'price.edit': row({ admin: ALL, procurement: ALL }),
  'cost.view': row({
    admin: ALL,
    qc_manager: ALL,
    qc_engineer: ALL,
    procurement: ALL,
    plant_manager: ALL,
    sales: 'setting:salesCanViewCost',
  }),
  'design.write': row({ qc_manager: ALL, qc_engineer: ALL }),
  'trial.request': row({ qc_manager: ALL, qc_engineer: ALL }),
  'lab.enter': row({ qc_manager: ALL, qc_engineer: ALL, plant_manager: ALL }),
  'trial.pass': row({ qc_manager: ALL }),
  'design.approve': row({ qc_manager: ALL }),
  'rules.read': row({ admin: ALL, qc_manager: ALL, qc_engineer: ALL }),
  'rules.verify': row({ qc_manager: ALL }),
  'design.attest': row({ qc_manager: ALL }),
  'production.release': row({ qc_manager: ALL, plant_manager: ALL }),
  'insight.accept': row({ qc_manager: ALL }),
  'insight.draft': row({ qc_manager: ALL, qc_engineer: ALL }),
  'library.read': row({
    admin: ALL,
    qc_manager: ALL,
    qc_engineer: ALL,
    procurement: ALL,
    plant_manager: ALL,
    sales: ALL,
    viewer: ALL,
  }),
  'materials.read': row({
    admin: ALL,
    qc_manager: ALL,
    qc_engineer: ALL,
    procurement: ALL,
    plant_manager: ALL,
  }),
  'materials.write': row({ qc_manager: ALL, qc_engineer: ALL }),
  'suppliers.write': row({ qc_manager: ALL, qc_engineer: ALL, procurement: ALL }),
  'import.run': row({ admin: ALL, qc_manager: ALL }),
  'export.priceCost': row({ admin: ALL, qc_manager: ALL, procurement: ALL }),
  'audit.read': row({ admin: ALL, qc_manager: ALL }),
};

function row(allowed: Partial<Record<Role, Cell>>): Record<Role, Cell> {
  const out = {} as Record<Role, Cell>;
  for (const role of ROLES) out[role] = allowed[role] ?? NO;
  return out;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleCan(role: Role, capability: Capability, settings: RbacSettings): boolean {
  const cell = MATRIX[capability][role];
  return cell === 'setting:salesCanViewCost' ? settings.salesCanViewCost : cell;
}

export function capabilitiesOf(role: Role, settings: RbacSettings): Capability[] {
  return CAPABILITIES.filter((c) => roleCan(role, c, settings));
}

/** Admin and QC Manager see every plant; everyone else only their assigned plants. */
export function isPlantScoped(role: Role): boolean {
  return role !== 'admin' && role !== 'qc_manager';
}

export interface PlantScope {
  all: boolean;
  plantIds: readonly string[];
}

export function canAccessPlant(scope: PlantScope, plantId: string): boolean {
  return scope.all || scope.plantIds.includes(plantId);
}

export class FourEyesViolation extends Error {
  constructor() {
    super('The author of a record cannot approve it (four-eyes rule).');
    this.name = 'FourEyesViolation';
  }
}

/** A record's author (created_by) may not approve/attest it. Unknown author also blocks. */
export function assertNotAuthor(actorId: string, authorId: string | null | undefined): void {
  if (!authorId || authorId === actorId) throw new FourEyesViolation();
}
