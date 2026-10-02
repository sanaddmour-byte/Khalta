import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  isRedirect,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { meQuery } from './lib/api';
import { NAV } from './lib/nav';
import { PlantsPage } from './admin/PlantsPage';
import { SettingsPage } from './admin/SettingsPage';
import { ImportsPage } from './imports/ImportsPage';
import { LibraryPage } from './library/LibraryPage';
import { MaterialsPage } from './materials/MaterialsPage';
import { PricesPage } from './prices/PricesPage';
import { LoginPage } from './pages/Login';
import { SectionPage } from './pages/Section';
import { RulesPage } from './rules/RulesPage';
import { SavingsPage } from './savings/SavingsPage';
import { StudioPage } from './studio/StudioPage';
import { Shell } from './shell/Shell';

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.fetchQuery(meQuery);
    } catch {
      return; // not signed in: show the form
    }
    throw redirect({ to: '/' });
  },
  component: LoginPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.fetchQuery(meQuery);
    } catch (e) {
      if (isRedirect(e)) throw e;
      throw redirect({ to: '/login' });
    }
  },
  component: Shell,
});

// Sections that have a real screen; the rest still show their teaching placeholder.
const SCREENS: Record<string, () => React.JSX.Element> = {
  rules: RulesPage,
  materials: MaterialsPage,
  prices: PricesPage,
  library: LibraryPage,
  savings: SavingsPage,
  studio: StudioPage,
  imports: ImportsPage,
  plants: PlantsPage,
  settings: SettingsPage,
};

const sectionRoutes = NAV.map((n) =>
  createRoute({
    getParentRoute: () => appRoute,
    path: n.path,
    component: SCREENS[n.id] ?? (() => <SectionPage id={n.id} />),
  }),
);

// Component gallery: development and screenshot runs only. The route (and its dynamic import) is
// created inside the DEV condition so production builds dead-code-eliminate the page entirely.
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/dev/components',
        component: lazyRouteComponent(() => import('./pages/DevComponents'), 'DevComponentsPage'),
      }),
    ]
  : [];

export const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren(sectionRoutes),
  ...devRoutes,
]);
export const createAppRouter = (queryClient: QueryClient) =>
  createRouter({ routeTree, context: { queryClient } });
