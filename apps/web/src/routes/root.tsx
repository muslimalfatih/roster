import { Link, Outlet } from '@tanstack/react-router';

const active = { className: 'navlink is-active' };

export function RootLayout() {
  return (
    <div className="min-h-screen bg-surface text-ink">
      <header className="nav">
        <nav className="mx-auto flex h-12 max-w-[720px] items-center gap-8 px-6">
          <Link to="/" className="text-[17px] font-semibold tracking-tight">
            roster
          </Link>
          <div className="flex gap-6 text-[13px]">
            <Link to="/" className="navlink" activeOptions={{ exact: true }} activeProps={active}>
              Classes
            </Link>
            <Link to="/roster" search={{ classId: undefined }} className="navlink" activeProps={active}>
              Roster
            </Link>
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-[720px] px-6 pb-28 pt-14">
        <Outlet />
      </main>
    </div>
  );
}
