import type { Capability } from '@khalta/rbac';
import {
  BookCheck,
  Boxes,
  CircleDollarSign,
  Factory,
  FlaskConical,
  LayoutDashboard,
  Layers,
  Library,
  Settings,
  TrendingDown,
  Upload,
  Lightbulb,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  id: string;
  path: string;
  icon: LucideIcon;
  /** Visible if the user has ANY of these capabilities; `null` = every signed-in user. */
  anyOf: Capability[] | null;
}

// Order and names follow 03-ui.md §3. Visibility derives from the same capabilities the server enforces.
export const NAV: NavItem[] = [
  { id: 'dashboard', path: '/', icon: LayoutDashboard, anyOf: null },
  { id: 'studio', path: '/studio', icon: FlaskConical, anyOf: ['design.write'] },
  { id: 'library', path: '/library', icon: Library, anyOf: ['library.read'] },
  { id: 'profiles', path: '/profiles', icon: Layers, anyOf: ['design.write'] },
  {
    id: 'insights',
    path: '/insights',
    icon: Lightbulb,
    anyOf: ['insight.draft', 'insight.accept'],
  },
  { id: 'savings', path: '/savings', icon: TrendingDown, anyOf: ['cost.view'] },
  {
    id: 'materials',
    path: '/materials',
    icon: Boxes,
    anyOf: ['materials.read'],
  },
  { id: 'prices', path: '/prices', icon: CircleDollarSign, anyOf: ['price.view'] },
  { id: 'plants', path: '/plants', icon: Factory, anyOf: ['org.manage'] },
  {
    id: 'rules',
    path: '/rules',
    icon: BookCheck,
    anyOf: ['rules.read'],
  },
  { id: 'imports', path: '/imports', icon: Upload, anyOf: ['import.run'] },
  { id: 'settings', path: '/settings', icon: Settings, anyOf: ['org.manage'] },
];

export function visibleNav(capabilities: readonly Capability[]): NavItem[] {
  return NAV.filter((n) => n.anyOf === null || n.anyOf.some((c) => capabilities.includes(c)));
}
