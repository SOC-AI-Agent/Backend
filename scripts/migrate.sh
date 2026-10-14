#!/bin/sh
# Bring the database at CORE_DATABASE_URL up to prisma/schema.prisma, then prove
# it got there. Run inside the backend image (deploy_production runs it before
# the API and the worker start):
#
#   docker compose run --rm --no-deps -T soc-core-api sh scripts/migrate.sh
#
# Three kinds of database, and what happens to each:
#
#   empty                 every migration is applied, 0_init first
#   migrated before       only the migrations it has not had are applied
#   FastAPI-era socai     tables but no _prisma_migrations: Prisma refuses with
#                         P3005. 0_init *is* that database (read from production
#                         by the inspect_db_schema job), so it is marked as
#                         applied — nothing is run for it — and the migrations
#                         after it are applied. Only when every table 0_init
#                         creates is already there; a non-empty database that is
#                         something else is left alone and the deploy stops.
#
# A local database made with `prisma db push` also has those tables and no
# history, but has the later columns too. It is told apart and left alone, with
# the two commands that record it as migrated.
#
# Then the drift check: the database must now match schema.prisma exactly. If it
# does not — a baseline that did not really fit, a column changed by hand — the
# SQL that would reconcile them is printed and the deploy stops before the API
# starts against a schema it does not expect. Nothing here drops anything: the
# migrations only add (see prisma/migrations/*/migration.sql).
set -eu
# No update check: the production containers have no route to the internet.
export PRISMA_HIDE_UPDATE_MESSAGE=1 CHECKPOINT_DISABLE=1

# What this image carries, before Prisma is asked anything. Without
# prisma/migrations, `migrate deploy` says "No migration found" and succeeds,
# and the drift check below then prints the whole schema as SQL — when the
# fault is a repository missing files. Every database needs 0_init, so its
# absence stops here, with what is there instead.
echo "migrate: migrations in this image: $(ls prisma/migrations 2>/dev/null | tr '\n' ' ')"
if [ ! -s prisma/migrations/0_init/migration.sql ]; then
  echo "migrate: prisma/migrations/0_init/migration.sql is missing or empty. Every"
  echo "         migration must be at prisma/migrations/<name>/migration.sql,"
  echo "         next to prisma/migrations/migration_lock.toml. Found:"
  find prisma -type f | sort | sed 's/^/           /'
  exit 1
fi

if out=$(npx prisma migrate deploy 2>&1); then
  echo "$out"
else
  echo "$out"
  case "$out" in
    *P3005*) ;;
    *P1000*)
      echo "migrate: the user or password in CORE_DATABASE_URL is wrong for this database."
      echo "         A database keeps the password it was created with: POSTGRES_PASSWORD"
      echo "         is read only when soc-db starts on an empty volume."
      exit 1 ;;
    *) echo "migrate: prisma migrate deploy failed — see above"; exit 1 ;;
  esac

  # "legacy" when this database has every table 0_init creates and nothing a
  # later migration adds (ai_jobs.lookup_status is the first of those); "pushed"
  # when it has both; otherwise the tables it lacks.
  kind=$(node -e '
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    const want = ["roles", "users", "api_keys", "ai_jobs", "audit_logs"];
    prisma.$queryRaw`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ${"public"}`
      .then((rows) => {
        const have = new Set(rows.map((r) => r.table_name));
        const missing = want.filter((t) => !have.has(t));
        const later = rows.some((r) => r.table_name === "ai_jobs" && r.column_name === "lookup_status");
        console.log(missing.length ? `missing: ${missing.join(" ")}` : later ? "pushed" : "legacy");
      })
      .catch((err) => { console.error(err.message); process.exit(1); })
      .finally(() => prisma.$disconnect());
  ')
  case "$kind" in
    legacy) ;;
    pushed)
      echo "migrate: this database already has the columns the migrations add — made with"
      echo "         prisma db push, not the FastAPI backend. Nothing changed. Record it as"
      echo "         migrated, then run this again to check it matches the schema:"
      echo "           npx prisma migrate resolve --applied 0_init"
      echo "           npx prisma migrate resolve --applied 20261014120000_nest_backend"
      exit 1 ;;
    *)
      echo "migrate: the database is not empty but is not the FastAPI-era socai database either"
      echo "         ($kind). Not baselining it — check CORE_DATABASE_URL."
      exit 1 ;;
  esac

  echo "migrate: FastAPI-era database with no migration history — baselining at 0_init"
  npx prisma migrate resolve --applied 0_init
  npx prisma migrate deploy
fi

# --exit-code: 0 the database matches the schema, 2 it does not, 1 diff failed.
# --from-schema-datasource reads CORE_DATABASE_URL the way the migrations did,
# rather than putting the password on a command line.
set +e
drift=$(npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script --exit-code 2>&1)
status=$?
set -e
if [ "$status" -ne 0 ]; then
  echo "$drift"
  echo "migrate: the database does not match prisma/schema.prisma after migrating (exit $status)."
  echo "         The SQL above is what would reconcile them. Not starting the backend."
  exit 1
fi
echo "migrate: database matches prisma/schema.prisma"
