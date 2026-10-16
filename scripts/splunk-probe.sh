#!/bin/sh
# Can this container reach Splunk's MCP endpoint, and would it trust the
# certificate? Run inside soc-core-worker by deploy_production (its last
# step), so it sees what the lookups see: the worker's SPLUNK_MCP_URL and
# NODE_EXTRA_CA_CERTS, its network and its DNS.
#
#   docker exec -i soc-core-worker sh -s < scripts/splunk-probe.sh
#
# Two questions kept apart, since Node reports both as "fetch failed":
#   network      with the certificate NOT checked (curl -k): does the name
#                resolve, does the port answer, what does the endpoint say.
#                Safe because no token is sent — there is nothing to steal.
#   certificate  who issued it, which names it covers, and whether this
#                container trusts it, NODE_EXTRA_CA_CERTS included — so the
#                CA to ask the Splunk team for is named before it is needed.
# Never sends the token. Always exits 0: it reports, nothing fails on it.

url=${SPLUNK_MCP_URL:-}
case "$url" in
  ""|*soc-mcp-splunk*)
    echo "SPLUNK_MCP_URL is not set (the CI variable): nothing to check"
    exit 0 ;;
esac
rest=${url#*://}; hostport=${rest%%/*}; host=${hostport%%:*}
if [ "$hostport" = "$host" ]; then
  case "$url" in https:*) hostport="$host:443" ;; *) hostport="$host:80" ;; esac
fi
echo "URL          $url"

# ── Network, certificate not checked ─────────────────────────────────────────
out=$(curl -k -sS -v -o /dev/null -w 'HTTP %{http_code}\n' --max-time 20 "$url" 2>&1 | tr -d '\r')
code=$(printf '%s\n' "$out" | sed -n 's/^HTTP \([0-9][0-9]*\)$/\1/p')
ip=$(printf '%s\n' "$out" | sed -n 's/^\* *Connected to [^(]*(\([^)]*\)).*/\1/p' | head -n 1)
# The address the name resolved to, also when nothing answered there: what a
# firewall rule has to name.
tried=$(printf '%s\n' "$out" | sed -n 's/^\* *Trying \([^ ]*\)\.\.\..*/\1/p' | head -n 1)
err=$(printf '%s\n' "$out" | sed -n 's/^curl: //p' | head -n 1)
if [ -z "$code" ] || [ "$code" = 000 ]; then
  echo "network      NOT reached${tried:+ ($tried)}: ${err:-no answer}"
  case "$err" in
    *"resolve host"*)
      echo "             $host does not resolve from this host: its DNS record, or this host's DNS server"
      exit 0 ;;
    *"timed out"*|*Timeout*) echo "             nothing answered on $hostport: a firewall between this host and Splunk, or the wrong port" ;;
    *refused*|*"connect to server"*) echo "             $hostport refused the connection: nothing listens on that port, or a firewall rejects it" ;;
  esac
  # The same machine on the port the MCP endpoint is documented on: one may
  # be open where the other is not.
  case "$hostport" in
    *:8089) ;;
    *)
      alt="https://$host:8089/services/mcp"
      acode=$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 10 "$alt" 2>/dev/null)
      case "$acode" in
        ""|000) echo "             $host:8089, the documented MCP port, does not answer either" ;;
        *) echo "             but $host:8089 answers (HTTP $acode): try SPLUNK_MCP_URL=$alt" ;;
      esac ;;
  esac
  exit 0
fi
echo "network      reached $hostport${ip:+ ($ip)}, answered HTTP $code"
case "$code" in
  401|403) echo "             the endpoint is there and asks for the token: the URL is right" ;;
  404) echo "             nothing at this path: the documented one is https://$host:8089/services/mcp" ;;
  405) echo "             the path exists but refused this request: likely right; check_splunk, with the token, confirms" ;;
  30[0-9])
    to=$(printf '%s\n' "$out" | sed -n 's/^< [Ll]ocation: *//p' | head -n 1)
    echo "             redirected${to:+ to $to}: a login page is Splunk Web, not the API — try https://$host:8089/services/mcp" ;;
  *) echo "             answered without asking for the token: a web page, not the MCP API? check the URL" ;;
esac

# ── Certificate ──────────────────────────────────────────────────────────────
case "$url" in https:*) ;; *) exit 0 ;; esac
echo "certificate  as $hostport presents it (s: whose, i: issued by):"
chain=$(openssl s_client -connect "$hostport" -servername "$host" </dev/null 2>/dev/null)
printf '%s\n' "$chain" | sed -n '/^Certificate chain/,/^---/p' | grep -E '^ *[0-9]+ s:|^ +i:|^ +v:' | sed 's/^/            /'
names=$(printf '%s\n' "$chain" | openssl x509 -noout -ext subjectAltName 2>/dev/null | sed -n '2,$p' | sed 's/^ *//')
[ -z "$names" ] || echo "             names it covers: $names"

ca=/etc/ssl/certs/ca-certificates.crt
extra=""
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
  if [ -r "$NODE_EXTRA_CA_CERTS" ]; then
    cat "$ca" "$NODE_EXTRA_CA_CERTS" > /tmp/splunk-probe-ca.pem && ca=/tmp/splunk-probe-ca.pem && extra=$NODE_EXTRA_CA_CERTS
  else
    echo "             NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS is not in the image: in production /app/certs/<file>.pem, committed to certs/"
  fi
fi
# -sS: silent when it succeeds, one "curl: (N) ..." line first when it does not.
verr=$(curl -sS -o /dev/null --max-time 20 --cacert "$ca" "$url" 2>&1 | head -n 1)
if [ -z "$verr" ]; then
  if [ -n "$extra" ]; then
    echo "trusted      yes, with $extra"
  else
    echo "trusted      yes, by the system's CAs alone: NODE_EXTRA_CA_CERTS is not needed"
  fi
else
  echo "trusted      NO: ${verr#curl: }"
  case "$verr" in
    *expired*) echo "             the certificate has expired: the Splunk team has to renew it" ;;
    *"subject name"*|*"not match"*|*"no alternative"*)
      echo "             it does not cover the name $host: use a name it covers (above), or ask for a certificate that has $host" ;;
    *) echo "             ask the Splunk team for the CA certificate that issued it (the last i: above), commit it to"
       echo "             certs/ and set the CI variable NODE_EXTRA_CA_CERTS=/app/certs/<file>.pem" ;;
  esac
fi
rm -f /tmp/splunk-probe-ca.pem
exit 0
