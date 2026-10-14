#!/bin/sh
# Print the schema of the database behind the running stack, read-only, so it
# can be compared with prisma/schema.prisma before any migration touches it.
#
# Structure only — no rows and no credentials are printed. psql runs with
# default_transaction_read_only=on, pg_dump reads, and `prisma migrate diff`
# only introspects: nothing here can change the database.
#
#   sh scripts/inspect-db-schema.sh      # needs the soc-db / soc-core-api containers
#
# Run by the manual `inspect_db_schema` job in .gitlab-ci.yml.
set -eu

DB_CONTAINER="${DB_CONTAINER:-soc-db}"
API_CONTAINER="${API_CONTAINER:-soc-core-api}"

# The database's own user and name come from inside its container, so no CI
# variable or password is involved.
psql_ro() {
  docker exec -i "$DB_CONTAINER" sh -c \
    'PGOPTIONS="-c default_transaction_read_only=on" psql -X -q -v ON_ERROR_STOP=1 -P pager=off -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"'
}

# GitLab collapsible log sections; plain headings anywhere else.
section() { printf '\n\033[0Ksection_start:%s:%s[collapsed=%s]\r\033[0K== %s ==\n' "$(date +%s)" "$1" "$2" "$3"; }
end_section() { printf '\033[0Ksection_end:%s:%s\r\033[0K\n' "$(date +%s)" "$1"; }

# Where the database lives on this host, and what else runs beside it — to plan
# how the backend connects to it. Names, images, networks, mounts and compose
# labels only: from the database container's environment, just its user and
# database name, never a password or any other variable.
section containers false "Containers, volumes and the database container"
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}\t{{.Networks}}'
echo
docker volume ls --format 'table {{.Name}}\t{{.Label "com.docker.compose.project"}}'
echo
docker inspect "$DB_CONTAINER" --format '
container  {{.Name}}
image      {{.Config.Image}}
status     {{.State.Status}} (started {{.State.StartedAt}})
project    {{index .Config.Labels "com.docker.compose.project"}} / service {{index .Config.Labels "com.docker.compose.service"}}
compose    {{index .Config.Labels "com.docker.compose.project.config_files"}}
networks   {{range $name, $n := .NetworkSettings.Networks}}{{$name}} {{end}}
mounts     {{range .Mounts}}{{.Type}}:{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}} -> {{.Destination}}  {{end}}
ports      {{range $p, $b := .NetworkSettings.Ports}}{{$p}}{{if $b}}->{{(index $b 0).HostPort}}{{end}} {{end}}'
docker exec "$DB_CONTAINER" sh -c 'echo "POSTGRES_USER  ${POSTGRES_USER:-(unset: postgres)}"; echo "POSTGRES_DB    ${POSTGRES_DB:-(unset)}"'
end_section containers

section server false "Server"
psql_ro <<'SQL'
SELECT current_database() AS database, current_setting('server_version') AS postgres, now() AS inspected_at;
SQL
end_section server

section columns false "Tables and columns"
psql_ro <<'SQL'
SELECT c.relname AS "table", a.attname AS "column",
       format_type(a.atttypid, a.atttypmod) AS "type",
       CASE WHEN a.attnotnull THEN 'NOT NULL' ELSE '' END AS "null",
       COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS "default"
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum;
SQL
end_section columns

section enums false "Enum types"
psql_ro <<'SQL'
SELECT t.typname AS "enum", string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder) AS "labels"
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
GROUP BY t.typname
ORDER BY 1;
SQL
end_section enums

section keys false "Constraints and indexes"
psql_ro <<'SQL'
SELECT conrelid::regclass AS "table", conname AS "constraint", pg_get_constraintdef(oid) AS "definition"
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace AND contype IN ('p', 'u', 'f', 'c')
ORDER BY 1, 2;

SELECT tablename AS "table", indexname AS "index", indexdef AS "definition"
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY 1, 2;
SQL
end_section keys

section migrations false "Prisma migration history"
psql_ro <<'SQL'
SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS has_migrations \gset
\if :has_migrations
SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at;
\else
\echo '(no _prisma_migrations table: prisma migrate has never been run against this database)'
\endif
SQL
end_section migrations

# What `prisma migrate` would have to change to make this database match the
# schema.prisma deployed in soc-core-api. Empty means they already match. Only
# when the deployed backend uses this database: before production's is wired
# in, it runs on a test database, and a diff of that would be shown here under
# this database's name. Only the host is read out of the URL — after its last
# @, so no part of a password can reach the log.
section drift false "Drift: SQL from this database to the deployed prisma/schema.prisma"
if [ "$(docker inspect -f '{{.State.Running}}' "$API_CONTAINER" 2>/dev/null)" = true ]; then
  docker exec -e PRISMA_HIDE_UPDATE_MESSAGE=1 -e CHECKPOINT_DISABLE=1 -e DB_HOST="$DB_CONTAINER" "$API_CONTAINER" sh -c '
    host=${CORE_DATABASE_URL##*@}; host=${host%%[:/?]*}
    if [ "$host" = "$DB_HOST" ]; then
      npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script
    else
      echo "(skipped: the deployed backend uses the database at $host, not $DB_HOST)"
    fi'
else
  echo "(skipped: $API_CONTAINER is not running, so there is no deployed schema to compare with)"
fi
end_section drift

section ddl true "Full schema DDL (pg_dump --schema-only)"
docker exec "$DB_CONTAINER" sh -c \
  'pg_dump --schema-only --no-owner --no-privileges -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"'
end_section ddl
