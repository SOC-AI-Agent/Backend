#!/bin/sh
# Which host ports the SOC stack publishes, and what holds each one now —
# read-only, so a port is chosen before a deploy finds it taken ("Bind for
# 0.0.0.0:8000 failed: port is already allocated").
#
#   sh scripts/inspect-ports.sh
#
# Run by the inspect_ports job of Backend (right after inspect_db_schema),
# Agent-Server and AI-Service: the same file in all three repositories, since
# it reads the whole host. Change one, copy it to the other two.
#
# Two sources. Docker's record of which container publishes which host port,
# running or stopped — a stopped one takes its ports back when it starts. And
# the host's listening sockets, read by netstat from a throwaway container in
# the host's network and process namespaces, which also shows what is not a
# container at all. Where another holds a port, the first port above it that
# nothing holds is named, for the variable that moves it.
set -eu

# <default host port> <the stack's container that publishes it> <what it is>
WANTED='8082 soc-core-api Backend API, BACKEND_HOST_PORT
3002 soc-dashboard Frontend, FRONTEND_HOST_PORT
8001 dall-m-server Agent-Server API, SERVER_HOST_PORT
7100 dall-m-frontend Agent-Server admin UI
8080 dall-m-llamacpp Agent-Server llama.cpp
5497 dall-m-db Agent-Server Postgres'
# A port chosen instead, where this job can see the variable: BACKEND_HOST_PORT
# is this project's own; the other two only as group variables. And any in the
# CI variable CHECK_PORTS (space-separated), for one run.
if [ -n "${BACKEND_HOST_PORT:-}" ]; then WANTED="$WANTED
$BACKEND_HOST_PORT soc-core-api Backend API, BACKEND_HOST_PORT"; fi
if [ -n "${FRONTEND_HOST_PORT:-}" ]; then WANTED="$WANTED
$FRONTEND_HOST_PORT soc-dashboard Frontend, FRONTEND_HOST_PORT"; fi
if [ -n "${SERVER_HOST_PORT:-}" ]; then WANTED="$WANTED
$SERVER_HOST_PORT dall-m-server Agent-Server API, SERVER_HOST_PORT"; fi
for p in ${CHECK_PORTS:-}; do WANTED="$WANTED
$p - CHECK_PORTS"; done

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

# Containers configured with host port $1: "name project status" per line.
on_port() {
  awk -F'|' -v p="$1" '{
      n = split($4, b, " ")
      for (i = 1; i <= n; i++) {
        split(b[i], hp, "->")
        if (hp[1] == p) { print $1, ($2 == "" ? "-" : $2), $3; break }
      }
    }' "$tmp/containers"
}
# What listens on host port $1: "PID/program" per line.
listening() {
  awk -v p="$1" '$1 ~ /^tcp/ && $6 == "LISTEN" { n = split($4, a, ":"); if (a[n] == p) print $7 }' "$tmp/listen" | sort -u
}
# The first port above $1 that no container is set on and nothing listens on.
next_free() {
  p=$(( $1 + 1 ))
  while [ "$p" -le $(( $1 + 100 )) ]; do
    if [ -z "$(on_port "$p")$(listening "$p")" ]; then echo "$p"; return; fi
    p=$(( p + 1 ))
  done
  echo "none within 100"
}

section wanted false "The stack's host ports, and what holds them"
printf '%-6s %-38s %s\n' PORT FOR NOW
printf '%s\n' "$WANTED" | while read -r port expect label; do
  [ -n "$port" ] || continue
  all=$(on_port "$port")
  own=$(printf '%s\n' "$all" | awk -v e="$expect" '$1 == e && $3 == "running"')
  others=$(printf '%s\n' "$all" | awk -v e="$expect" '$3 == "running" && $1 != e { printf "%s%s (%s)", s, $1, $2; s = ", " }')
  stopped=$(printf '%s\n' "$all" | awk -v e="$expect" 'NF && $3 != "running" && $1 != e { printf "%s%s (%s)", s, $1, $2; s = ", " }')
  procs=$(listening "$port" | tr '\n' ' ')
  # The service already moved: its container runs, published on another port
  # (its *_HOST_PORT is set). Then no other port is suggested.
  moved=""
  if [ "$expect" != "-" ] && [ -z "$own" ]; then
    moved=$(awk -F'|' -v e="$expect" '$1 == e && $3 == "running" {
        n = split($4, b, " ")
        for (i = 1; i <= n; i++) { split(b[i], hp, "->"); printf "%s%s", s, hp[1]; s = "," }
      }' "$tmp/containers")
  fi
  if [ -n "$own" ]; then
    now="ok, $expect itself"
  elif [ -n "$others" ]; then
    now="TAKEN by $others"
  elif [ -n "$procs" ]; then
    now="TAKEN, not by a container: ${procs% }"
  else
    now="free"
  fi
  if [ -n "$moved" ]; then
    now="$now; ok, $expect runs on $moved instead"
  elif [ "${now#TAKEN}" != "$now" ]; then
    now="$now; free instead: $(next_free "$port")"
  fi
  # Another stopped container set on it takes it back when it starts — and
  # then it, or this service, fails to start.
  if [ -n "$stopped" ]; then now="$now; also set on stopped $stopped"; fi
  printf '%-6s %-38s %s\n' "$port" "$label" "$now"
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

# When a port answers here but a browser elsewhere times out, something drops
# the packets on the way: this host's own filter, or the network between. The
# two sections below tell those apart from this side. Every address the host
# has (a browser that cannot reach one may reach another — DEPLOY_HOST in the
# deploy jobs), and its packet filter as iptables lists it: INPUT and FORWARD
# policies, INPUT and DOCKER-USER rules, and the DNAT rules Docker made for
# published ports. Listed only (-S), from a throwaway container with NET_ADMIN
# in the host's network namespace; both iptables backends, since the host
# uses one and the other lists nothing. firewalld keeps its own nftables
# tables, which iptables does not show — whether it runs is reported.
section addresses true "This host's addresses"
docker run --rm --network host --entrypoint sh "$PROBE_IMAGE" -c \
  'ip -4 -o addr show scope global | grep -v -E " (docker0|br-|veth)" | sed -n "s/^[0-9]*: *\([^ ]*\) *inet \([0-9.\/]*\).*/\2  \1/p"' \
  || echo "(could not be read)"
end_section addresses

section firewall true "This host's packet filter"
docker run --rm --network host --pid host --cap-add NET_ADMIN --cap-add NET_RAW --entrypoint sh "$PROBE_IMAGE" -c '
  if pgrep -x firewalld >/dev/null 2>&1; then
    echo "firewalld is running: its own nftables rules are not listed here"
  fi
  for ipt in iptables-nft iptables-legacy; do
    rules=$($ipt -S 2>/dev/null) || continue
    [ -n "$(printf "%s\n" "$rules" | grep -v "^-P ")" ] || continue
    echo "--- $ipt"
    printf "%s\n" "$rules" | grep -E "^-P (INPUT|FORWARD) |^-A (INPUT|DOCKER-USER) "
    echo "  DNAT for published ports:"
    $ipt -t nat -S DOCKER 2>/dev/null | grep DNAT | sed "s/^/    /"
  done' || echo "(could not be read)"
end_section firewall
