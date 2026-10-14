#!/bin/sh
# Which host ports the SOC stack publishes, and what holds each one now —
# read-only, so a port is chosen before a deploy finds it taken ("Bind for
# 0.0.0.0:8000 failed: port is already allocated").
#
#   sh scripts/inspect-ports.sh
#
# Run by the inspect_ports job in .gitlab-ci.yml, right after inspect_db_schema.
#
# Two sources. Docker's record of which container publishes which host port,
# running or stopped — a stopped one takes its ports back when it starts. And
# the host's listening sockets, read by netstat from a throwaway container in
# the host's network and process namespaces, which also shows what is not a
# container at all.
set -eu

# The stack's host ports on the production host: each default, and the
# alternative where the FastAPI-era stack already holds the default. More for
# one run: the CI variable CHECK_PORTS, space-separated.
WANTED='8081 Backend API (soc-core-api)
3000 Frontend, default
3001 Frontend, FRONTEND_HOST_PORT
8000 Agent-Server API, default
8001 Agent-Server API, SERVER_HOST_PORT
7100 Agent-Server admin UI
8080 Agent-Server llama.cpp
5497 Agent-Server Postgres'
for p in ${CHECK_PORTS:-}; do
  WANTED="$WANTED
$p CHECK_PORTS"
done

# netstat from the job's own image (alpine's busybox): already on this host.
PROBE_IMAGE="${CI_JOB_IMAGE:-docker:latest}"

# GitLab collapsible log sections; plain headings anywhere else.
section() { printf '\n\033[0Ksection_start:%s:%s[collapsed=%s]\r\033[0K== %s ==\n' "$(date +%s)" "$1" "$2" "$3"; }
end_section() { printf '\033[0Ksection_end:%s:%s\r\033[0K\n' "$(date +%s)" "$1"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# name|project|status|hostport->port/proto ...
docker ps -aq | xargs -r docker inspect -f \
  '{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{.State.Status}}|{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}}->{{$p}} {{end}}{{end}}' \
  | sed 's|^/||' > "$tmp/containers"

# Proto Recv-Q Send-Q Local-Address Foreign-Address State PID/Program
: > "$tmp/listen"
if ! docker run --rm --network host --pid host --entrypoint netstat "$PROBE_IMAGE" -tlnp \
     > "$tmp/listen" 2> "$tmp/listen.err"; then
  echo "(the host's listening sockets could not be read: $(head -n 1 "$tmp/listen.err"))" > "$tmp/listen.note"
fi

section wanted false "The stack's host ports, and what holds them"
printf '%-6s %-34s %s\n' PORT FOR NOW
# Containers configured with this host port: running ones, or the others.
holders() {
  awk -F'|' -v p="$1" -v want="$2" '($3 == "running") == (want == "running") {
      n = split($4, b, " ")
      for (i = 1; i <= n; i++) {
        split(b[i], hp, "->")
        if (hp[1] == p) { printf "%s%s (%s)", sep, $1, ($2 == "" ? "no compose project" : $2); sep = ", "; break }
      }
    }' "$tmp/containers"
}

printf '%s\n' "$WANTED" | while read -r port label; do
  [ -n "$port" ] || continue
  running=$(holders "$port" running)
  stopped=$(holders "$port" stopped)
  procs=$(awk -v p="$port" '$1 ~ /^tcp/ && $6 == "LISTEN" { n = split($4, a, ":"); if (a[n] == p) print $7 }' "$tmp/listen" \
    | sort -u | tr '\n' ' ')
  if [ -n "$running" ]; then
    now="TAKEN by $running"
  elif [ -n "$procs" ]; then
    now="TAKEN, not by a container: ${procs% }"
  else
    now="free"
  fi
  # A stopped container takes its ports back when it starts — after a deploy
  # bound this one, it would be the one that fails.
  if [ -n "$stopped" ]; then now="$now; also set on stopped $stopped"; fi
  printf '%-6s %-34s %s\n' "$port" "$label" "$now"
done
end_section wanted

section containers true "Containers that publish host ports"
printf '%-24s %-24s %-10s %s\n' CONTAINER PROJECT STATUS 'HOST PORT->CONTAINER PORT'
awk -F'|' '$4 != "" { printf "%-24s %-24s %-10s %s\n", $1, ($2 == "" ? "-" : $2), $3, $4 }' "$tmp/containers" | sort
end_section containers

section listening true "Listening on the host (TCP)"
if [ -f "$tmp/listen.note" ]; then
  cat "$tmp/listen.note"
else
  printf '%-7s %-26s %s\n' PORT ADDRESS PROCESS
  awk '$1 ~ /^tcp/ && $6 == "LISTEN" { n = split($4, a, ":"); printf "%-7s %-26s %s\n", a[n], $4, $7 }' "$tmp/listen" | sort -n -u
fi
end_section listening
