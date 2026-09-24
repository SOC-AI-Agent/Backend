
import sys

if sys.version_info < (3, 12):
    raise SystemExit(
        f"needs Python 3.12 (the version the services run), found "
        f"{sys.version.split()[0]}.\n"
        "macOS ships 3.9 as python3; use the project venv:\n"
        "  python3.12 -m venv .venv && .venv/bin/python -m pip install -q -r scripts/requirements.txt\n"
        "  .venv/bin/python " + " ".join(sys.argv)
    )
#!/usr/bin/env python3
"""
Work out field signatures from alerts that could not be placed.

A signature is a set of field names that identifies one log family. Writing
them by hand means knowing every family that will ever arrive, which nobody
does — so derive them instead, from the alerts themselves.

    python3 scripts/derive_signatures.py samples/mockup.json

Alerts that already say where they came from are skipped: a notable carrying
orig_security_domain needs no signature. What is left is grouped by the fields
they share, and for each group the script looks for fields that are present in
every member and in no other group. Those identify it.

Prints an ALERT_SOURCE_SIGNATURES line to paste into .env. The domain and
sourcetype are left as TODO, because which domain a family belongs to is a
judgement about your estate, not something the fields can settle.
"""

import argparse
import collections
import json
from pathlib import Path

# Below this, a group is too small to tell a family's core fields from the ones
# a single kind of event happens to carry.
SMALL_GROUP = 5

# An alert carrying any of these already says where it came from.
PLACED_BY = ("orig_security_domain", "orig_sourcetype", "data_model", "orig_index")
DEFAULT_DOMAINS = {"access", "endpoint", "network", "threat", "identity", "audit", "cloud"}

# Present in nearly every log, so useless for telling families apart. A
# signature built on these matches everything, which is the same as matching
# nothing.
COMMON = {
    "host", "source", "sourcetype", "index", "_time", "_raw", "time", "timestamp",
    "severity", "type", "action", "user", "count", "src", "dest", "message",
    "src_ip", "dest_ip", "srcip", "dstip", "src_port", "dest_port", "signature",
    "eventtype", "tag", "punct", "linecount", "date", "status", "id", "name",
}


def fields_of(alert: dict) -> set:
    return {k.lower() for k in alert if not isinstance(alert[k], (dict, list))}


def already_placed(alert: dict, domains: set[str], allow_search_name: bool) -> str | None:
    for key in PLACED_BY:
        if alert.get(key):
            return key
    if not allow_search_name:
        return None
    prefix = str(alert.get("search_name", "")).split(" - ")[0].strip().lower()
    return "search_name prefix" if prefix in domains else None


def load_domains(path: str | None) -> set[str]:
    if not path:
        return DEFAULT_DOMAINS
    raw = json.loads(Path(path).read_text())
    if isinstance(raw, list):
        domains = raw
    elif isinstance(raw, dict):
        domains = raw.keys()
    else:
        raise ValueError("domains file must contain a JSON array or object")
    result = {str(domain).strip().lower() for domain in domains if str(domain).strip()}
    if not result:
        raise ValueError("domains file must contain at least one domain")
    return result


def jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def cluster(items: list[set], threshold: float) -> list[list[int]]:
    """Merge the closest pair until nothing is close enough. Average linkage, so
    one odd member cannot pull a whole group along behind it."""
    groups = [[i] for i in range(len(items))]
    while len(groups) > 1:
        best, bi, bj = 0.0, None, None
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                pairs = [jaccard(items[a], items[b]) for a in groups[i] for b in groups[j]]
                avg = sum(pairs) / len(pairs)
                if avg > best:
                    best, bi, bj = avg, i, j
        if best < threshold:
            break
        groups[bi] += groups[bj]
        groups.pop(bj)
    return sorted(groups, key=lambda g: -len(g))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("alerts", nargs="?", help="JSON array of alerts; omit for stdin")
    ap.add_argument("--similarity", type=float, default=0.4,
                    help="how alike two alerts must be to group (0-1, default 0.4)")
    ap.add_argument("--max-fields", type=int, default=3,
                    help="fields per signature (default 3)")
    ap.add_argument("--keep-common", action="store_true",
                    help="allow ubiquitous fields in a signature")
    ap.add_argument("--domains", help="JSON array/object of approved search_name prefixes")
    ap.add_argument("--allow-search-name-prefix", action="store_true",
                    help="treat an approved search_name prefix as placed; off by default")
    ap.add_argument("--min-group-size", type=int, default=SMALL_GROUP,
                    help=f"do not emit rules for smaller groups (default {SMALL_GROUP})")
    args = ap.parse_args()

    if args.similarity < 0 or args.similarity > 1:
        ap.error("--similarity must be between 0 and 1")
    if args.max_fields < 1:
        ap.error("--max-fields must be at least 1")
    if args.min_group_size < 0:
        ap.error("--min-group-size cannot be negative")

    try:
        domains = load_domains(args.domains)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        ap.error(f"invalid --domains file: {exc}")

    raw = Path(args.alerts).read_text() if args.alerts else sys.stdin.read()
    alerts = json.loads(raw)
    if isinstance(alerts, dict):
        alerts = [alerts]

    placed, unplaced = [], []
    if not isinstance(alerts, list) or not all(isinstance(alert, dict) for alert in alerts):
        ap.error("input must be a JSON object or an array of JSON objects")

    for a in alerts:
        by = already_placed(a, domains, args.allow_search_name_prefix)
        (placed if by else unplaced).append((a, by))

    print(f"{len(alerts)} alerts: {len(placed)} already say where they came from, "
          f"{len(unplaced)} do not\n", file=sys.stderr)
    if placed:
        counts = collections.Counter(by for _, by in placed)
        for key, n in counts.most_common():
            print(f"  {n:3} placed by {key}", file=sys.stderr)
        print(file=sys.stderr)

    if not unplaced:
        print("Nothing needs a signature.", file=sys.stderr)
        return 0

    sets = [fields_of(a) for a, _ in unplaced]
    groups = cluster(sets, args.similarity)
    print(f"{len(groups)} group(s) among the unplaced\n", file=sys.stderr)

    rules = []
    for n, group in enumerate(groups, start=1):
        members = [sets[i] for i in group]
        common = set.intersection(*members)
        # Every field any other group carries. What survives is what identifies
        # this one and nothing else.
        elsewhere = set().union(*[sets[i] for i in range(len(sets))
                                  if i not in group]) if len(groups) > 1 else set()
        unique = common - elsewhere
        if not args.keep_common:
            unique -= COMMON

        example = unplaced[group[0]][0]
        label = example.get("search_name") or example.get("eventName") or "(unnamed)"

        print(f"group {n}: {len(group)} alert(s) — e.g. {str(label)[:52]}", file=sys.stderr)

        if not unique:
            # Either one group, or two families that genuinely share every
            # distinctive field. Both need a person to look.
            fallback = sorted(common - COMMON)[:args.max_fields]
            print(f"  no field is unique to this group. Shared and distinctive: "
                  f"{', '.join(fallback) or 'none'}", file=sys.stderr)
            print("  -> check whether these are really one family before writing a rule\n",
                  file=sys.stderr)
            continue

        chosen = sorted(sorted(unique, key=lambda f: (-len(f), f))[:args.max_fields])
        print(f"  unique to it: {', '.join(sorted(unique)[:12])}"
              f"{' …' if len(unique) > 12 else ''}", file=sys.stderr)
        print(f"  suggested:    {' + '.join(chosen)}", file=sys.stderr)

        if len(group) < args.min_group_size:
            # With a handful of near-identical alerts there is no way to tell a
            # field that every record of the family carries from one that only
            # this kind of event does. AWS CloudTrail is the example: an
            # AssumedRole record has credentialsIssuedTo, a plain API call does
            # not, and a signature built on it would miss most of the family.
            print(f"  ⚠ only {len(group)} alert(s) in this group — the fields above may",
                  file=sys.stderr)
            print("    belong to this kind of event rather than to the whole family.",
                  file=sys.stderr)
            print("    Pick from the list by hand: choose names that every record of",
                  file=sys.stderr)
            print("    the family carries, not ones specific to this event.",
                  file=sys.stderr)
            print("    no rule emitted; pass --min-group-size 0 to include it anyway.",
                file=sys.stderr)
            print(file=sys.stderr)
            continue
        print(file=sys.stderr)
        rules.append("+".join(chosen) + "=TODO_domain:TODO_sourcetype")

    if rules:
        print("Paste into .env, replacing each TODO:\n", file=sys.stderr)
        print("ALERT_SOURCE_SIGNATURES=" + ",".join(rules))
    return 0


if __name__ == "__main__":
    sys.exit(main())
