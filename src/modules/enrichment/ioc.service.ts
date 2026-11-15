import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { indicatorRegistry } from './indicator-registry';

/** A name from catalog/indicator-types.json: ip, domain, url, hash, file, ... */
export type IndicatorType = string;

export interface Indicator {
  type: IndicatorType;
  value: string;
  /** Where it came from: a named log field, the SOAR payload, or free text. */
  source: string;
}

export interface ExtractionResult {
  indicators: Indicator[];
  /**
   * Values found in the alert that are not worth a threat-intelligence
   * lookup — and the type is kept, because "not worth asking ThreatQ about"
   * is not "not worth searching Splunk for". An internal address is the
   * clearest case: no intel provider has heard of 10.1.100.44, and it is the
   * single most useful thing to search the logs for. `searchable` says which.
   */
  skipped: Array<{ value: string; reason: string; type: IndicatorType; searchable: boolean }>;
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
    const registry = indicatorRegistry();
    const indicators: Indicator[] = [];
    const unsupported: string[] = [];

    for (const item of supplied ?? []) {
      const type = item.type?.toLowerCase();
      if (registry.has(type)) {
        indicators.push({ type, value: item.value, source: item.source ?? 'soar' });
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
    const registry = indicatorRegistry();
    const found = new Map<string, Indicator>();
    const skipped: ExtractionResult['skipped'] = [];

    // What the SOAR already parsed beats anything re-derived from the text: its
    // playbook had the structured record, this only has the rendering of it.
    for (const indicator of supplied ?? []) {
      this.consider(indicator, found, skipped);
    }

    // Key=value first: a value that arrives under `srcip=` is an address because
    // the device said so, which beats matching digits out of free text.
    for (const [, field, value] of rawLog.matchAll(registry.keyValue)) {
      const type = registry.typeForLogField(field);
      if (type) this.consider({ type, value, source: field }, found, skipped);
    }

    // Then free text, in the registry's order. A URL carries its host (hostAs),
    // and its path carries things shaped like hostnames that are not — `/p.bin`
    // matches the domain pattern — so a type can ignore matches inside another
    // (notInside).
    for (const name of registry.scanOrder) {
      const def = registry.types[name];
      const outer = def.notInside ? registry.types[def.notInside].pattern : undefined;
      const spans = outer
        ? [...rawLog.matchAll(outer)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length])
        : [];
      for (const match of rawLog.matchAll(def.pattern!)) {
        const at = match.index ?? 0;
        if (spans.some(([from, to]) => at >= from && at < to)) continue;
        this.consider({ type: name, value: match[0], source: 'text' }, found, skipped);
        if (def.hostAs) {
          const host = this.hostOf(match[0]);
          if (host) this.consider({ type: def.hostAs, value: host, source: name }, found, skipped);
        }
      }
    }

    return { indicators: [...found.values()], skipped };
  }

  private consider(
    indicator: Indicator,
    found: Map<string, Indicator>,
    skipped: ExtractionResult['skipped'],
  ): void {
    const registry = indicatorRegistry();
    const value = indicator.value.trim().replace(/[.,;:]+$/, '');
    if (!value) return;
    // A match that is really another type is recorded as that type, not dropped:
    // `php-webshell.php` is no domain, and it is exactly what to search a web log for.
    const type = registry.reclassify(indicator.type, value);

    const key = `${type}:${value.toLowerCase()}`;
    // First writer wins: a value seen under `srcip=` keeps that provenance
    // rather than being overwritten by the same string found in free text.
    if (found.has(key)) return;

    const verdict = registry.verdict(type, value, {
      internal: (this.config.get<string[]>('enrichment.internal') ?? []).map((e) => e.toLowerCase()),
    });
    if (verdict) {
      if (!skipped.some((s) => s.value === value)) {
        skipped.push({ value, type, ...verdict });
      }
      return;
    }
    found.set(key, { ...indicator, type, value });
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
}
