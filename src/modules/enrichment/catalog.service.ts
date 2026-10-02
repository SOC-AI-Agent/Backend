import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';

/**
 * The data catalogue, read here so a search can be aimed before a model sees it.
 *
 * The same file the Splunk connector reads. It is what turns "10.1.100.44 is a
 * source IP" into "search `srcip` in index main, sourcetype fortigate" — and
 * that translation has exactly one right answer, so it belongs in code.
 *
 * The failure it exists to stop is not an error. An agent told to look for a
 * domain in `query`, `domain`, `dest_host` and `url_domain` — the CIM names —
 * against FortiGate logs that carry none of them gets back zero events and
 * reports that nothing was found. The search succeeded; the answer is wrong;
 * nothing anywhere says so.
 */

/** A meaning, and the field name this sourcetype uses for it. */
export type RoleMap = Record<string, string>;

export interface SourcetypeEntry {
  purpose?: string;
  roles?: RoleMap;
  fields?: string[];
  notes?: string[];
}

export interface IndexEntry {
  purpose?: string;
  sourcetypes?: Record<string, SourcetypeEntry>;
}

/**
 * Which roles a detail under a requirement names, by its key. The requirements
 * agent labels each detail (`device: FGT-01`, `user: j.smith`); this is what turns
 * the label into this estate's field name. A key not listed gets no field hint —
 * the detail is still sent to Text-to-SPL, just without a field.
 */
const DETAIL_ROLES: Record<string, string[]> = {
  source: ['src_ip'], src: ['src_ip'], src_ip: ['src_ip'], source_ip: ['src_ip'],
  destination: ['dest_ip'], dest: ['dest_ip'], dst: ['dest_ip'], dest_ip: ['dest_ip'],
  ip: ['src_ip', 'dest_ip'],
  src_port: ['src_port'], dest_port: ['dest_port'], port: ['dest_port'],
  user: ['user'], username: ['user'], user_name: ['user'], account: ['user'],
  device: ['host'], host: ['host'], hostname: ['host'],
  domain: ['domain'],
  hash: ['hash'], md5: ['hash'], sha1: ['hash'], sha256: ['hash'],
  action: ['action'],
};
// `source` and `destination` name an address only when the value is one; a host
// name under either key is not a src_ip.
const ADDRESS_KEYS = new Set(['source', 'src', 'destination', 'dest', 'dst']);
const ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:]+)$/i;

/** Which roles an indicator of each kind could be carried by. */
const INDICATOR_ROLES: Record<string, string[]> = {
  ip: ['src_ip', 'dest_ip'],
  host: ['host'],
  user: ['user'],
  hash: ['hash'],
  domain: ['domain'],
};

@Injectable()
export class CatalogService implements OnModuleInit {
  private readonly logger = new Logger(CatalogService.name);
  private indexes: Record<string, IndexEntry> = {};

  onModuleInit(): void {
    const path = process.env.SPLUNK_CATALOG_FILE ?? '/catalog/splunk-catalog.json';
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { indexes?: Record<string, IndexEntry> };
      this.indexes = raw.indexes ?? {};
      const sourcetypes = Object.values(this.indexes).reduce(
        (n, i) => n + Object.keys(i.sourcetypes ?? {}).length,
        0,
      );
      this.logger.log(
        `catalog loaded from ${path}: ${Object.keys(this.indexes).length} indexes, ${sourcetypes} sourcetypes`,
      );
    } catch (err: any) {
      // Not fatal. Without it the plan carries the indicator but no field
      // names, and the query agent falls back to working them out — slower and
      // less certain, but not broken.
      this.logger.warn(
        `no catalog at ${path} (${err?.message ?? err}) — searches will not be scoped to a field`,
      );
      this.indexes = {};
    }
  }

  get loaded(): boolean {
    return Object.keys(this.indexes).length > 0;
  }

  indexNames(): string[] {
    return Object.keys(this.indexes);
  }

  /** Sourcetypes in one index, for checking that a search still points at
   *  something that exists. */
  sourcetypeNames(index: string): string[] {
    return Object.keys(this.indexes[index]?.sourcetypes ?? {});
  }

  /**
   * Field names carrying `role`, narrowed as far as the caller can narrow it.
   *
   * Passing an index and sourcetype is the point. Unscoped, this returns every
   * spelling of a source IP anywhere in the estate — on a lab with one
   * sourcetype that is the same answer, and on a real one it is an OR across
   * hundreds of fields that matches events from systems the alert never
   * touched.
   */
  fieldsForRole(role: string, index?: string | null, sourcetype?: string | null): string[] {
    const found: string[] = [];
    for (const [indexName, indexEntry] of Object.entries(this.indexes)) {
      if (index && indexName !== index) continue;
      for (const [stName, st] of Object.entries(indexEntry.sourcetypes ?? {})) {
        if (sourcetype && stName !== sourcetype) continue;
        const field = st.roles?.[role];
        if (field && !found.includes(field)) found.push(field);
      }
    }
    return found;
  }

  /** Every field an indicator of this kind could sit in, scoped the same way. */
  fieldsForIndicator(
    indicatorType: string,
    index?: string | null,
    sourcetype?: string | null,
  ): string[] {
    const fields: string[] = [];
    for (const role of INDICATOR_ROLES[indicatorType] ?? []) {
      for (const field of this.fieldsForRole(role, index, sourcetype)) {
        if (!fields.includes(field)) fields.push(field);
      }
    }
    return fields;
  }

  /**
   * The fields one detail under a requirement sits in (`user: j.smith` -> `user`,
   * `device: FGT-01` -> `devname`), scoped like the indicator it travels with.
   * Empty when the key names no role or the catalogue has no field for it.
   */
  fieldsForDetail(key: string, value: string, index?: string | null, sourcetype?: string | null): string[] {
    const roles = DETAIL_ROLES[key];
    if (!roles) return [];
    if (ADDRESS_KEYS.has(key) && !ADDRESS.test(value)) return [];
    const fields: string[] = [];
    for (const role of roles) {
      for (const field of this.fieldsForRole(role, index, sourcetype)) {
        if (!fields.includes(field)) fields.push(field);
      }
    }
    // Unscoped, a role can have a spelling per sourcetype; a hint listing ten is noise.
    return fields.slice(0, 4);
  }

  /**
   * Where to look for one indicator: narrowest scope that has a field for it.
   *
   * The alert's own sourcetype first, then its index, then the whole estate.
   * Widening matters because the thing worth searching for is often not
   * recorded where the alert came from — a FortiGate UTM detection names a
   * domain, and the sourcetype that carries domains is the DNS or web proxy
   * one, in a different index. Scoping only to the alert's sourcetype would
   * report "nothing here records a domain" while the estate records it next
   * door.
   *
   * `scope` is returned rather than inferred so the widening is visible: a
   * search that had to cross into another sourcetype is a weaker link to this
   * alert than one that did not, and the analyst should be able to see which
   * they are reading.
   */
  resolveIndicator(
    indicatorType: string,
    index?: string | null,
    sourcetype?: string | null,
    roles?: string[],
  ): { fields: string[]; index?: string; sourcetype?: string; scope: 'sourcetype' | 'index' | 'estate' | 'none' } {
    // `roles` narrows the search to one direction when the caller asked for
    // one: src_ip alone rather than src_ip OR dest_ip. Omitted means every
    // role an indicator of this kind could sit in.
    const fieldsAt = (i?: string | null, st?: string | null) =>
      roles?.length
        ? roles.flatMap((r) => this.fieldsForRole(r, i, st)).filter((f, n, a) => a.indexOf(f) === n)
        : this.fieldsForIndicator(indicatorType, i, st);

    if (index && sourcetype) {
      const fields = fieldsAt(index, sourcetype);
      if (fields.length > 0) return { fields, index, sourcetype, scope: 'sourcetype' };
    }
    if (index) {
      const fields = fieldsAt(index, null);
      if (fields.length > 0) return { fields, index, scope: 'index' };
    }
    const fields = fieldsAt(null, null);
    if (fields.length > 0) return { fields, scope: 'estate' };
    return { fields: [], scope: 'none' };
  }

  /**
   * Which roles this sourcetype has no field for.
   *
   * The gap that is worth naming out loud. `fortigate` carries no `domain`
   * role, so a domain lookup found nothing in the catalogue, fell through to
   * CIM names that this data does not use, and searched four fields that do
   * not exist — returning zero events and a warning nobody was reading.
   */
  missingRoles(index?: string | null, sourcetype?: string | null): string[] {
    return Object.keys(INDICATOR_ROLES).filter(
      (t) => this.fieldsForIndicator(t, index, sourcetype).length === 0,
    );
  }

  /** What a sourcetype is for, when the catalogue says. */
  purposeOf(index?: string | null, sourcetype?: string | null): string | undefined {
    if (!index) return undefined;
    const entry = this.indexes[index];
    if (!entry) return undefined;
    if (!sourcetype) return entry.purpose;
    return entry.sourcetypes?.[sourcetype]?.purpose ?? entry.purpose;
  }
}
