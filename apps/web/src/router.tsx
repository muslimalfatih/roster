import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { RootLayout } from './routes/root';
import { ClassesPage } from './routes/classes';
import { BookPage } from './routes/book';
import { RosterPage } from './routes/roster';

// Code-based routing on purpose: file-based routing would need @tanstack/router-plugin
// codegen and a generated routeTree.gen.ts — an extra build step and generated file to
// keep in sync, for zero benefit at three static routes.
const rootRoute = createRootRoute({ component: RootLayout });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ?classId=… is optional and validated here, so a missing or malformed param lands on
 * the page's "pick a class" state instead of reaching Postgres and 500ing with 22P02.
 */
const validateClassId = (search: Record<string, unknown>): { classId: string | undefined } => ({
  classId: typeof search.classId === 'string' && UUID.test(search.classId) ? search.classId : undefined,
});

const classesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ClassesPage,
});

const bookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/book',
  validateSearch: validateClassId,
  component: BookPage,
});

const rosterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/roster',
  validateSearch: validateClassId,
  component: RosterPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([classesRoute, bookRoute, rosterRoute]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
