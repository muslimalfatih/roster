import { Link, Outlet } from '@tanstack/react-router';

const linkClass = 'px-3 py-1.5 rounded text-sm text-slate-600 hover:bg-slate-200';
const activeProps = { className: `${linkClass} bg-slate-900 text-white hover:bg-slate-900` };

export function RootLayout() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <nav className="mx-auto flex max-w-3xl items-center gap-2 px-6 py-3">
          <span className="mr-2 font-semibold">roster</span>
          <Link to="/" className={linkClass} activeOptions={{ exact: true }} activeProps={activeProps}>
            Classes
          </Link>
          <Link
            to="/roster"
            search={{ classId: undefined }}
            className={linkClass}
            activeProps={activeProps}
          >
            Admin roster
          </Link>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
