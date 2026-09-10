# Deployment

> **The container setup is UNTESTED.** No Docker daemon was running on the machine this was built
> on, so `apps/api/Dockerfile` and `docker-compose.yml` have never been built or run. They are
> written from the workspace layout, not verified against it. To verify, from the **repo root**:
>
> ```sh
> docker build -f apps/api/Dockerfile -t roster-api .   # context MUST be the repo root
> docker compose up --build
> curl localhost:3000/api/health                        # expect {"ok":true}
> curl localhost:3000/api/classes                       # expect the three seeded classes
> docker compose down -v                                # -v also drops the seeded volume
> ```
>
> Everything under "Local without Docker" below *is* what runs on the dev machine today and was
> executed end to end against a scratch database while writing this.

Topology: **API** on Dokploy (self-hosted, Docker), **web** on Vercel, **Postgres** on Supabase or a
Dokploy Postgres service.

## Environment variables

| Side | Var | Example | Notes |
|---|---|---|---|
| API | `DATABASE_URL` | `postgres://user:pw@host:5432/roster` | **Required** — `src/env.ts` throws at startup if it is missing. Supabase: use the **session/direct** connection string. Managed Postgres usually needs `?sslmode=require`. |
| API | `PORT` | `3000` | Defaults to 3000. The image exposes and healthchecks 3000, so leave it alone unless you have a reason. |
| API | `CORS_ORIGIN` | `https://roster.vercel.app` | Exact origin: scheme included, no trailing slash, no path. Unset means "reflect any origin" — acceptable locally, never in a deployed setting. |
| API | `SEAT_HOLD_MINUTES` | `10` | How long a seat stays `locked` before the hold lapses and the seat becomes claimable again. Defaults to 10. |
| Web | `VITE_API_BASE_URL` | `https://api.example.com` | The API's public origin. See the build-time note below. |

Local-only extras, used by the test and load-test runners rather than by the server:
`TEST_DATABASE_URL` (bun suite) and `LOAD_DATABASE_URL` (`tests/load/run.sh`). The root
`.env.example` is the complete list and marks which app each variable belongs to.

**`VITE_*` vars are inlined at BUILD time.** Vite substitutes them into the JS bundle; nothing reads
them at runtime. Changing the API URL therefore requires a **redeploy of the web app**, not just an
environment edit in the Vercel dashboard. If `VITE_API_BASE_URL` is unset at build time the bundle
falls back to `http://localhost:3001`, which is a local default and will silently break a deployed
frontend — set it.

## Verify the image before you deploy it

The container has never been built on the author's machine — no Docker daemon was available. Do this
first, because a broken image is much easier to diagnose locally than through a deploy log:

```sh
docker build -f apps/api/Dockerfile -t roster-api .        # context is the repo root
docker run --rm -e DATABASE_URL="$DATABASE_URL" -p 3000:3000 roster-api
curl localhost:3000/api/health                             # {"ok":true}
```

If the build fails at `corepack`, it is almost certainly the signature check that Node's bundled
corepack applies to newer pnpm releases. Replace line 14 of the Dockerfile with:

```dockerfile
RUN npm install -g pnpm@11.22.0
```

## Dokploy (API)

Assumes Dokploy with the Traefik proxy it ships by default.

1. **Database first.** Either create a Postgres service in Dokploy (note its internal host, e.g.
   `roster-db`) or create a Supabase project and copy its connection string.
2. **Create Application** → source **GitHub** → this repo, branch `main`.
3. **Build type: Dockerfile.**
   - Build context / build path: **`.`** — the repo root. This is not optional: it is a pnpm
     workspace and `@roster/api` depends on `@roster/types` via `workspace:*`, which only resolves
     if the root manifest, `pnpm-workspace.yaml` and both package directories are present.
   - Dockerfile path: **`apps/api/Dockerfile`**
4. **Environment:** `DATABASE_URL`, `PORT=3000`, `CORS_ORIGIN=<your Vercel origin>`. Nothing is
   baked into the image.
5. **Domain:** attach e.g. `api.example.com`, container port `3000`, enable HTTPS (Let's Encrypt).
   Deploy.
6. **Apply the schema once.** There are no migrations — `schema.sql` is the whole story, and it is
   idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`). From any machine
   that can reach the database:
   ```sh
   psql "$DATABASE_URL" -f apps/api/db/schema.sql
   psql "$DATABASE_URL" -f apps/api/db/seed.sql    # optional demo data — TRUNCATES every table
   ```
   Equivalently, from the container terminal, where `db/` ships alongside the source:
   ```sh
   bun scripts/reset-db.ts        # cwd is already /app/apps/api
   ```
   Note it is `bun scripts/reset-db.ts`, not `pnpm db:reset`: the runtime image is bun-only, with no
   node and no pnpm, so package scripts are not runnable there.
7. Verify:
   ```sh
   curl https://api.example.com/api/health     # {"ok":true}
   curl https://api.example.com/api/classes    # the seeded classes with live seat counts
   ```

`.dockerignore` lives at the **repo root**, because that is the build context — Docker reads it from
there and nowhere else. It keeps `node_modules`, `dist`, `.env`, `apps/web`, `docs` and `**/tests`
out of the image, so `COPY apps/api` cannot bake a local connection string or a host symlink farm
into the build. Excluding `**/tests` is safe for the runtime: the `preload` in `apps/api/bunfig.toml`
is `[test]`-scoped, so `bun src/index.ts` never looks at it.

## Vercel (web, monorepo subdirectory)

1. Import the repo. **Root Directory: `apps/web`**, and keep *"Include source files outside of the
   Root Directory"* **enabled** — the build needs the root `package.json`, `pnpm-workspace.yaml` and
   `packages/types` to resolve `workspace:*`.
2. Framework preset: **Vite**. Package manager: pnpm (auto-detected from `packageManager`). Leave
   the commands on their defaults unless the build fails; the working set is:
   - Install: `pnpm install --frozen-lockfile` (Vercel runs this at the repo root)
   - Build: `pnpm build` → `tsc --noEmit && vite build`
   - Output directory: `dist`

   These live in project settings, not in `vercel.json`, so they cannot conflict with what Vercel
   infers.
3. Env var: `VITE_API_BASE_URL=https://api.example.com` (Production **and** Preview).
4. Deploy, note the origin (`https://<project>.vercel.app`), then set `CORS_ORIGIN` on the API to
   that exact string and redeploy the API.

`apps/web/vercel.json` rewrites every path to `/index.html`. TanStack Router is client-side: without
it, a hard refresh of `/roster` or a shared link asks Vercel for a file that does not exist and gets
a 404. It is a rewrite, not a redirect — the URL is preserved and the router reads it.

## The CORS handshake

Two variables, on opposite sides, that must agree:

```
browser ──▶ VITE_API_BASE_URL (baked into the web bundle at build time)
                     │
                     ▼
                   API ──▶ CORS_ORIGIN must equal the exact Vercel origin
```

A mismatch shows up as a CORS error in the browser console while `curl` against the API works fine —
`curl` does not enforce CORS. Two gotchas:

- Preview deployments get their own `*.vercel.app` origins and will be blocked unless added.
- `CORS_ORIGIN` must have no trailing slash. `https://x.vercel.app/` never matches
  `https://x.vercel.app`.

## Local with Docker

```sh
docker compose up --build
```

Brings up `postgres:16-alpine` on host port **5433** (to dodge a local Postgres on 5432) with
`schema.sql` + `seed.sql` mounted into `/docker-entrypoint-initdb.d/`, and the API on
`http://localhost:3000` once the DB healthcheck passes. Init scripts run **only on an empty data
volume** — `docker compose down -v` to start clean. If host port 3000 is taken, change the API port
mapping in `docker-compose.yml`. Untested; see the note at the top.

## Local without Docker (what actually works today)

Requires **Postgres 14+**, **Bun 1.4+**, **pnpm 11+**, and **k6** for the load tests. Create the
three databases once — `createdb` takes a single DBNAME and reads a second argument as the
description, so `createdb a b c` does *not* create three databases:

```sh
for db in roster roster_test roster_load; do createdb "$db"; done
pnpm install
cp .env.example apps/api/.env     # API config
cp .env.example apps/web/.env     # Vite only picks up the VITE_* line
pnpm db:reset                     # schema.sql + seed.sql into $DATABASE_URL
pnpm dev                          # API on $PORT, web on http://localhost:5173
```

Two edits to make in the copied files first:

- **DSN user.** `.env.example` uses `postgres://postgres@localhost:5432/…`. A Homebrew Postgres
  creates a superuser role named after your OS user instead, in which case all three DSNs in
  `apps/api/.env` need that name.
- **Port agreement.** If 3000 is taken, set `PORT=3001` in `apps/api/.env` **and**
  `VITE_API_BASE_URL=http://localhost:3001` in `apps/web/.env`. They must match, and the web bundle
  reads its value at build/dev-server start.

Both `.env` files are gitignored.

```sh
pnpm test        # bun integration suite against roster_test (applies schema+seed itself)
pnpm typecheck   # all three packages
pnpm build       # web production build

./tests/load/run.sh booking-last-seat    # k6 — see tests/load/README.md
./tests/load/run.sh booking-duplicate
./tests/load/run.sh payment-failure
echo $?                                  # 0 = every threshold held
```

`run.sh` resets `roster_load`, starts the API against it on **:3999**, waits for `/api/health`, runs
k6, then kills the API from an `EXIT` trap and exits with k6's code. Override the port with
`LOAD_PORT=…`.

One footgun worth knowing: `pnpm db:reset` works because pnpm runs it with the working directory set
to `apps/api`, where bun auto-loads `apps/api/.env`. Running `bun apps/api/scripts/reset-db.ts` from
the repo root instead fails fast with *"DATABASE_URL is not set"* — pass it explicitly:

```sh
DATABASE_URL=postgres://…/roster bun apps/api/scripts/reset-db.ts
```
