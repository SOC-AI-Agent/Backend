import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The indicator types, read from catalog/indicator-types.json.
 *
 * One file says, for every kind of indicator, how to find it in a log, which
 * catalogue roles it can sit in, which common field names to fall back on, and
 * whether it goes to threat intelligence. IocService, CatalogService and
 * ThreatQService all read it, so a new type is a data change and the three can no
 * longer disagree — the way a filename that looked like a domain was extracted as
 * one, and then could not be aimed because no web log has a domain field.
 */

/** A skip rule as the file names it: a rule name, or a rule with its parameters. */
type SkipSpec = string | { rule: string; reason?: string; suffixes?: string[] };

interface TypeSpec {
  logFields?: string[];
  pattern?: string;
  patternFlags?: string;
  roles?: string[];
  cim?: string[];
  threatIntel?: boolean;
  local?: boolean;
  skip?: SkipSpec[];
  reclassify?: { to: string; suffixes: string[] };
  hostAs?: string;
  notInside?: string;
}

interface RegistryFile {
  keyValuePattern: string;
  scanOrder?: string[];
  types: Record<string, TypeSpec>;
  detailKeys?: Record<string, string[]>;
  addressKeys?: string[];
}

/** Why a value was dropped, and whether it is still worth a Splunk search. */
export interface SkipVerdict {
  reason: string;
  searchable: boolean;
}

/** What a skip rule can consult beyond the value: the configured internal names. */
export interface SkipContext {
  internal: string[];
}

type SkipRule = (value: string, spec: Exclude<SkipSpec, string> | undefined, ctx: SkipContext) => SkipVerdict | null;

const isPrivateIp = (ip: string): boolean => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224 // multicast and reserved
  );
};

/**
 * The checks a type can name in `skip`. Code, because each is a judgement a
 * regex cannot make; which type uses which is data. `searchable` is the part that
 * matters downstream: an internal address is useless to ThreatQ and the single
 * most useful thing to search Splunk for.
 */
const SKIP_RULES: Record<string, SkipRule> = {
  private_ip: (v) => (isPrivateIp(v) ? { reason: 'private or non-routable address', searchable: true } : null),
  internal: (v, _s, ctx) => {
    const lower = v.toLowerCase();
    return ctx.internal.some((e) => lower === e || lower.endsWith(e))
      ? { reason: 'listed as internal', searchable: true }
      : null;
  },
  xml_namespace_url: (v) =>
    /^https?:\/\/(?:schemas\.microsoft\.com|www\.w3\.org)\b/i.test(v)
      ? { reason: 'XML schema namespace, not a URL indicator', searchable: false }
      : null,
  xml_namespace_domain: (v) =>
    ['schemas.microsoft.com', 'www.w3.org'].includes(v.toLowerCase())
      ? { reason: 'XML schema namespace, not a domain', searchable: false }
      : null,
  relative_path: (v) => (v.startsWith('/') ? { reason: 'relative URI path', searchable: true } : null),
  // Field names with dots (date_hour, http.method) match the domain pattern.
  not_resolvable: (v) => (/\.[a-z]{2,24}$/i.test(v) ? null : { reason: 'not a resolvable domain', searchable: false }),
  suffix: (v, spec) =>
    (spec?.suffixes ?? []).some((s) => v.toLowerCase().endsWith(s))
      ? { reason: spec?.reason ?? 'excluded suffix', searchable: false }
      : null,
};

const PLACEHOLDER = /^(?:not_translated|-|none|n\/?a|unknown|null)$/i;

export interface IndicatorTypeDef {
  name: string;
  logFields: string[];
  pattern?: RegExp;
  roles: string[];
  cim: string[];
  threatIntel: boolean;
  local: boolean;
  reclassify?: { to: string; suffixes: string[] };
  hostAs?: string;
  notInside?: string;
  skip: Array<{ rule: SkipRule; spec?: Exclude<SkipSpec, string> }>;
}

export class IndicatorRegistry {
  readonly types: Record<string, IndicatorTypeDef> = {};
  readonly keyValue: RegExp;
  readonly scanOrder: string[];
  readonly detailKeys: Record<string, string[]>;
  readonly addressKeys: Set<string>;
  private readonly byLogField = new Map<string, string>();

  constructor(file: RegistryFile, readonly path: string) {
    this.keyValue = new RegExp(file.keyValuePattern, 'g');
    for (const [name, t] of Object.entries(file.types ?? {})) {
      const skip = (t.skip ?? []).map((s) => {
        const ruleName = typeof s === 'string' ? s : s.rule;
        const rule = SKIP_RULES[ruleName];
        if (!rule) throw new Error(`${path}: type ${name} names an unknown skip rule "${ruleName}"`);
        return { rule, spec: typeof s === 'string' ? undefined : s };
      });
      this.types[name] = {
        name,
        logFields: (t.logFields ?? []).map((f) => f.toLowerCase()),
        pattern: t.pattern ? new RegExp(t.pattern, t.patternFlags ?? 'gi') : undefined,
        roles: t.roles ?? [],
        cim: t.cim ?? [],
        threatIntel: t.threatIntel === true,
        local: t.local === true,
        reclassify: t.reclassify,
        hostAs: t.hostAs,
        notInside: t.notInside,
        skip,
      };
      for (const f of this.types[name].logFields) {
        if (!this.byLogField.has(f)) this.byLogField.set(f, name);
      }
    }
    for (const t of Object.values(this.types)) {
      for (const ref of [t.reclassify?.to, t.hostAs, t.notInside]) {
        if (ref && !this.types[ref]) throw new Error(`${path}: type ${t.name} refers to unknown type "${ref}"`);
      }
    }
    this.scanOrder = (file.scanOrder ?? Object.keys(this.types)).filter((n) => this.types[n]?.pattern);
    this.detailKeys = file.detailKeys ?? {};
    this.addressKeys = new Set(file.addressKeys ?? []);
  }

  names(): string[] {
    return Object.keys(this.types);
  }

  has(type: string | undefined): boolean {
    return !!type && type in this.types;
  }

  /** The type a key=value field name carries, by convention across vendors. */
  typeForLogField(field: string): string | null {
    return this.byLogField.get(field.toLowerCase()) ?? null;
  }

  /** A match that is really another type: `php-webshell.php` found as a domain is a file. */
  reclassify(type: string, value: string): string {
    const r = this.types[type]?.reclassify;
    if (r && r.suffixes.some((s) => value.toLowerCase().endsWith(s))) return r.to;
    return type;
  }

  /** Null when the value is kept as an indicator for threat intel; else why not, and whether to still search it. */
  verdict(type: string, value: string, ctx: SkipContext): SkipVerdict | null {
    if (PLACEHOLDER.test(value)) return { reason: 'placeholder value, not an indicator', searchable: false };
    const def = this.types[type];
    if (!def) return { reason: `unknown indicator type ${type}`, searchable: false };
    for (const { rule, spec } of def.skip) {
      const hit = rule(value, spec, ctx);
      if (hit) return hit;
    }
    if (def.local) return { reason: 'local endpoint artifact', searchable: true };
    return null;
  }
}

let cached: IndicatorRegistry | undefined;

/** Where the file is: INDICATOR_TYPES_FILE, the image's /catalog, or the repo's catalog/. */
function locate(): string {
  const candidates = [
    process.env.INDICATOR_TYPES_FILE,
    '/catalog/indicator-types.json',
    join(__dirname, '..', '..', '..', 'catalog', 'indicator-types.json'),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    // Fatal on purpose: without it nothing is extracted, and an alert with no
    // indicators looks clean rather than broken.
    throw new Error(`indicator types not found (looked in ${candidates.join(', ')})`);
  }
  return found;
}

export function indicatorRegistry(): IndicatorRegistry {
  if (!cached) {
    const path = locate();
    cached = new IndicatorRegistry(JSON.parse(readFileSync(path, 'utf8')) as RegistryFile, path);
  }
  return cached;
}

/** For tests: read the file again on the next call. */
export function resetIndicatorRegistry(): void {
  cached = undefined;
}
