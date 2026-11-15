import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type IndicatorType = 'ip' | 'domain' | 'url' | 'hash' | 'email' | 'user' | 'host' | 'process' | 'service';

export interface Indicator {
  type: IndicatorType;
  value: string;
  /** Where it came from: a named log field, the SOAR payload, or free text. */
  source: string;
}

export interface ExtractionResult {
  indicators: Indicator[];
  /** Dropped before any lookup, with the reason. Kept so "why was this not
   *  checked" has an answer without re-running anything. */
  /**
   * Values found in the alert that are not worth a threat-intelligence
   * lookup — and the type is kept, because "not worth asking ThreatQ about"
   * is not "not worth searching Splunk for". An internal address is the
   * clearest case: no intel provider has heard of 10.1.100.44, and it is the
   * single most useful thing to search the logs for.
   */
  skipped: Array<{ value: string; reason: string; type: IndicatorType }>;
}

/**
 * Pull indicators out of an alert, deterministically.
 *
 * This is the part that must not be a model's job. Extracting `10.1.100.11`
 * from a log line is exact work with one right answer — a regex gets it every
 * time, in microseconds, for free, and cannot decide to skip one. A model does
 * it slower, differently each run, and occasionally not at all.
 *
 * Filtering matters as much as finding. Asking a threat-intelligence platform
 * about an RFC1918 address wastes a call on an answer that is always "no
 * record", and a "no record" reply is exactly what gets misread as "clean".
 */
@Injectable()
export class IocService {
  private readonly logger = new Logger(IocService.name);

  // Key=value first: a value that arrives under `srcip=` is an address because
  // the device said so, which beats matching digits out of free text.
  private static readonly KV = /\b([a-zA-Z][\w.-]{1,40})\s*=\s*"?([^"\s,;]{1,512})"?/g;

  private static readonly IPV4 =
    /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
  private static readonly URL = /\bhttps?:\/\/[^\s"'<>\\]{4,2048}/gi;
  private static readonly EMAIL = /\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+\b/g;
  private static readonly HASH = /\b(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})\b/gi;
  private static readonly DOMAIN =
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;

  /** Log fields that name an address, a host or a user, by convention across
   *  vendors. A catalog per sourcetype would be better; this is the floor. */
  private static readonly FIELD_HINTS: Record<IndicatorType, string[]> = {
    ip: ['srcip', 'dstip', 'src_ip', 'dest_ip', 'source_ip', 'destination_ip', 'src', 'dest',
         'clientip', 'client_ip', 'remote_ip', 'ip', 'transip', 'source_network_address'],
    domain: ['domain', 'query', 'dns_query', 'url_domain', 'fqdn', 'cs-host'],
    url: ['url', 'uri', 'uri_path', 'referer', 'request'],
    hash: ['md5', 'sha1', 'sha256', 'hash', 'file_hash', 'filehash'],
    email: ['sender', 'recipient', 'from', 'to', 'email', 'mail_from'],
    user: ['user', 'username', 'user_name', 'src_user', 'account', 'account_name', 'samaccountname'],
    host: ['host', 'hostname', 'computer', 'computername', 'devname', 'dvc'],
    process: ['process', 'process_name', 'image', 'parentimage', 'service_file_name'],
    service: ['service_name'],
  };

  // Suffixes that appear in log text but are never something to look up.
  private static readonly NON_ROUTABLE_SUFFIX = ['.local', '.internal', '.lan', '.corp', '.home.arpa'];

  // A filename is not a domain. `p.bin` and `invoice.zip` both satisfy the
  // domain pattern, and looking either up wastes a call on a certain miss.
  private static readonly FILE_SUFFIX = [
    '.bin', '.exe', '.dll', '.zip', '.rar', '.7z', '.gz', '.tar', '.doc', '.docx',
    '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.js', '.vbs', '.ps1', '.bat', '.cmd',
    '.jar', '.msi', '.iso', '.img', '.dat', '.tmp', '.log', '.txt', '.csv', '.png',
    '.jpg', '.jpeg', '.gif', '.svg', '.html', '.htm', '.php', '.asp', '.aspx', '.jsp',
  ];

  constructor(private readonly config: ConfigService) {}

  /**
   * Narrow indicators that arrived from outside to the types handled here.
   *
   * The SOAR may send a type this side does not know — narrowing at the edge
   * keeps that from becoming an `any` that reaches a lookup and fails there.
   */
  normalise(
    supplied?: Array<{ type: string; value: string; source?: string }>,
  ): { indicators: Indicator[]; unsupported: string[] } {
    const known = new Set<string>(Object.keys(IocService.FIELD_HINTS));
    const indicators: Indicator[] = [];
    const unsupported: string[] = [];

    for (const item of supplied ?? []) {
      const type = item.type?.toLowerCase();
      if (known.has(type)) {
        indicators.push({
          type: type as IndicatorType,
          value: item.value,
          source: item.source ?? 'soar',
        });
      } else if (type && !unsupported.includes(type)) {
        unsupported.push(type);
      }
    }
    if (unsupported.length > 0) {
      this.logger.warn(`ignoring indicator types this service does not handle: ${unsupported.join(', ')}`);
    }
    return { indicators, unsupported };
  }

  extract(rawLog: string, supplied?: Indicator[]): ExtractionResult {
    const found = new Map<string, Indicator>();
    const skipped: ExtractionResult['skipped'] = [];

    // What the SOAR already parsed beats anything re-derived from the text: its
    // playbook had the structured record, this only has the rendering of it.
    for (const indicator of supplied ?? []) {
      this.consider(indicator, found, skipped);
    }

    for (const [, field, value] of rawLog.matchAll(IocService.KV)) {
      const type = this.typeForField(field.toLowerCase());
      if (type) this.consider({ type, value, source: field }, found, skipped);
    }

    this.scan(rawLog, IocService.URL, 'url', found, skipped);
    this.scan(rawLog, IocService.EMAIL, 'email', found, skipped);
    this.scan(rawLog, IocService.HASH, 'hash', found, skipped);
    this.scan(rawLog, IocService.IPV4, 'ip', found, skipped);

    // A URL already carries its host, and its path carries things shaped like
    // hostnames that are not — `/p.bin` matches the domain pattern. So take the
    // host from the URL itself, and ignore domain matches inside a URL span.
    const urlSpans: Array<[number, number]> = [];
    for (const match of rawLog.matchAll(IocService.URL)) {
      const start = match.index ?? 0;
      urlSpans.push([start, start + match[0].length]);
      const host = this.hostOf(match[0]);
      if (host) this.consider({ type: 'domain', value: host, source: 'url' }, found, skipped);
    }

    for (const match of rawLog.matchAll(IocService.DOMAIN)) {
      const at = match.index ?? 0;
      if (urlSpans.some(([from, to]) => at >= from && at < to)) continue;
      this.consider({ type: 'domain', value: match[0], source: 'text' }, found, skipped);
    }

    return { indicators: [...found.values()], skipped };
  }

  private scan(
    text: string,
    pattern: RegExp,
    type: IndicatorType,
    found: Map<string, Indicator>,
    skipped: ExtractionResult['skipped'],
  ): void {
    for (const match of text.matchAll(pattern)) {
      this.consider({ type, value: match[0], source: 'text' }, found, skipped);
    }
  }

  private consider(
    indicator: Indicator,
    found: Map<string, Indicator>,
    skipped: ExtractionResult['skipped'],
  ): void {
    const value = indicator.value.trim().replace(/[.,;:]+$/, '');
    if (!value) return;

    const key = `${indicator.type}:${value.toLowerCase()}`;
    // First writer wins: a value seen under `srcip=` keeps that provenance
    // rather than being overwritten by the same string found in free text.
    if (found.has(key)) return;

    const reason = this.skipReason(indicator.type, value);
    if (reason) {
      if (!skipped.some((s) => s.value === value)) {
        skipped.push({ value, reason, type: indicator.type });
      }
      return;
    }
    found.set(key, { ...indicator, value });
  }

  private skipReason(type: IndicatorType, value: string): string | null {
    if (/^(?:not_translated|-|none|n\/?a|unknown|null)$/i.test(value)) {
      return 'placeholder value, not an indicator';
    }
    if (type === 'host' || type === 'process' || type === 'service') {
      return 'local endpoint artifact';
    }
    if (type === 'url') {
      if (/^https?:\/\/(?:schemas\.microsoft\.com|www\.w3\.org)\b/i.test(value)) {
        return 'XML schema namespace, not a URL indicator';
      }
      if (value.startsWith('/')) {
        return 'relative URI path';
      }
    }
    if (type === 'ip') {
      if (this.isPrivate(value)) return 'private or non-routable address';
      if (this.isInternal(value)) return 'listed as internal infrastructure';
    }
    if (type === 'domain') {
      const lower = value.toLowerCase();
      if (lower === 'schemas.microsoft.com' || lower === 'www.w3.org') {
        return 'XML schema namespace, not a domain';
      }
      if (IocService.NON_ROUTABLE_SUFFIX.some((s) => lower.endsWith(s))) {
        return 'non-routable domain suffix';
      }
      if (IocService.FILE_SUFFIX.some((s) => lower.endsWith(s))) {
        return 'filename, not a domain';
      }
      // Field names with dots (date_hour, http.method) match the domain pattern.
      if (!/\.[a-z]{2,24}$/i.test(lower)) return 'not a resolvable domain';
      if (this.isInternal(lower)) return 'listed as internal infrastructure';
    }
    if (type === 'user' || type === 'email') {
      if (this.isInternal(value.toLowerCase())) return 'listed as internal';
    }
    return null;
  }

  /** Host part of a URL, without throwing on the malformed ones logs contain. */
  private hostOf(url: string): string | null {
    try {
      const { hostname } = new URL(url);
      return hostname || null;
    } catch {
      return null;
    }
  }

  private isPrivate(ip: string): boolean {
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
  }

  private isInternal(value: string): boolean {
    const list = this.config.get<string[]>('enrichment.internal') ?? [];
    return list.some((entry) => value === entry || value.endsWith(entry));
  }

  private typeForField(field: string): IndicatorType | null {
    for (const [type, names] of Object.entries(IocService.FIELD_HINTS)) {
      if (names.includes(field)) return type as IndicatorType;
    }
    return null;
  }
}
