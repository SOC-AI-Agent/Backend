import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent } from 'https';
import { firstValueFrom } from 'rxjs';

import { indicatorRegistry } from './indicator-registry';
import { Indicator } from './ioc.service';
import { ThreatQRecord, ThreatQResult } from './threatq.service';

// Lookups in flight at once, as for ThreatQ.
const CONCURRENCY = 5;
// MISP's threat_level_id, on the event an attribute belongs to.
const THREAT_LEVEL: Record<string, string> = { '1': 'High', '2': 'Medium', '3': 'Low', '4': 'Undefined' };
// Tags that say what an indicator is, in the order they are worth showing.
const VERDICT_TAG = /^(soc-lab:verdict|misp:confidence-level|admiralty-scale:source-reliability)=/i;
const ADVERSARY_TAG = /^misp-galaxy:(threat-actor|intrusion-set)=|^threat-actor[:=]/i;

class MispError extends Error {}

/**
 * Indicator reputation from MISP — the open-source TIP — in the same shape
 * ThreatQService gives, so the rest of the enrichment cannot tell them apart.
 *
 * One read per indicator: POST /attributes/restSearch by value, event tags
 * included. A value with no attribute is `found: false` — never seen, which is
 * not clean. Read-only, with a read-only user's key.
 */
@Injectable()
export class MispService {
  private readonly logger = new Logger(MispService.name);
  private agent?: Agent;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    const c = this.config.get('enrichment.misp');
    return Boolean(c.baseUrl && c.apiKey);
  }

  async lookup(indicators: Indicator[]): Promise<ThreatQResult> {
    const types = indicatorRegistry().types;
    const lookupable = indicators.filter((i) => types[i.type]?.threatIntel);
    if (!this.enabled) {
      return { source: 'MISP', available: false, hits: [], checked: 0, error: 'MISP is not configured' };
    }
    if (lookupable.length === 0) return { source: 'MISP', available: true, hits: [], checked: 0 };

    const { maxIndicators } = this.config.get('enrichment.misp');
    const batch = lookupable.slice(0, maxIndicators);
    if (batch.length < lookupable.length) {
      this.logger.warn(`capping MISP lookup at ${maxIndicators} of ${lookupable.length} indicators`);
    }

    const records: ThreatQRecord[] = [];
    const errors: string[] = [];
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const settled = await Promise.allSettled(
        batch.slice(i, i + CONCURRENCY).map((ind) => this.search(ind.type, ind.value)),
      );
      for (const s of settled) {
        if (s.status === 'fulfilled') records.push(s.value);
        else errors.push(s.reason?.message ?? String(s.reason));
      }
    }

    if (errors.length) this.logger.error(`MISP lookup: ${errors.length} of ${batch.length} failed: ${errors[0]}`);
    // As for ThreatQ: a failed lookup must not fail the job, and must not read as clean.
    if (records.length === 0 && errors.length) {
      return { source: 'MISP', available: false, hits: [], checked: 0, failed: errors.length, error: errors[0] };
    }
    return {
      source: 'MISP',
      available: true,
      checked: records.length,
      hits: records.filter((r) => r.found),
      ...(errors.length ? { failed: errors.length, error: errors[0] } : {}),
    };
  }

  private async search(type: string, value: string): Promise<ThreatQRecord> {
    const { baseUrl, apiKey, timeoutMs } = this.config.get('enrichment.misp');
    let data: any;
    try {
      ({ data } = await firstValueFrom(
        this.http.post<any>(
          `${baseUrl}/attributes/restSearch`,
          { returnFormat: 'json', value, includeEventTags: true, deleted: false, limit: 50 },
          {
            timeout: timeoutMs,
            headers: { Authorization: apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
            httpsAgent: this.httpsAgent(),
            // A login page or a proxy error is not an answer.
            validateStatus: () => true,
          },
        ),
      ));
    } catch (err: any) {
      throw new MispError(`cannot reach MISP at ${baseUrl}: ${err?.message ?? err}`);
    }
    if (data?.response === undefined) {
      const said = data?.message ?? data?.errors ?? (typeof data === 'string' ? data.slice(0, 120) : 'no response object');
      throw new MispError(`MISP did not answer the search (${JSON.stringify(said)}) — wrong MISP_API_KEY or MISP_BASE_URL?`);
    }
    return toRecord(type, value, data.response.Attribute ?? []);
  }

  private httpsAgent(): Agent | undefined {
    const { baseUrl, verifyTls } = this.config.get('enrichment.misp');
    if (!baseUrl.startsWith('https:') || verifyTls) return undefined;
    // A self-signed lab instance only; MISP_VERIFY_TLS defaults to true.
    this.agent ??= new Agent({ rejectUnauthorized: false });
    return this.agent;
  }
}

/** What MISP holds about one value, as a ThreatQ-shaped record. Exported for tests. */
export function toRecord(type: string, value: string, attributes: any[]): ThreatQRecord {
  if (!attributes.length) return { value, type, found: false };

  const uniq = (xs: Array<string | undefined | null>) => [...new Set(xs.filter((x): x is string => Boolean(x)))];
  const tags = uniq(attributes.flatMap((a) => (a.Tag ?? []).map((t: any) => t?.name)));
  const levels = uniq(attributes.map((a) => THREAT_LEVEL[String(a.Event?.threat_level_id ?? '')]));
  const verdicts = tags.filter((t) => VERDICT_TAG.test(t)).map((t) => t.split('=').slice(1).join('=').replace(/"/g, ''));
  const forDetection = attributes.some((a) => a.to_ids === true || a.to_ids === 1 || a.to_ids === '1');
  // When it was observed: the attribute's own first/last seen, else its event's
  // date. Never `timestamp` — that is when the record was last edited.
  const seen = attributes.map((a) => a.first_seen || a.Event?.date).filter(Boolean).sort();
  const lastSeen = attributes.map((a) => a.last_seen || a.Event?.date).filter(Boolean).sort();

  return {
    value,
    type,
    found: true,
    id: attributes[0].id,
    // MISP has no score; the event's threat level is the nearest thing.
    score: levels.length ? `threat level ${levels.join('/')}` : undefined,
    status: [
      verdicts.length ? verdicts.join(', ') : null,
      forDetection ? 'flagged for detection (to_ids)' : 'context only (not to_ids)',
    ].filter(Boolean).join('; '),
    sources: uniq(attributes.map((a) => (a.Event?.info ? `MISP event ${a.event_id}: ${a.Event.info}` : `MISP event ${a.event_id}`))),
    adversaries: uniq(tags.filter((t) => ADVERSARY_TAG.test(t)).map((t) => t.split('=').slice(1).join('=').replace(/"/g, ''))),
    context: uniq([
      ...attributes.map((a) => a.comment),
      ...tags.filter((t) => !VERDICT_TAG.test(t) && !ADVERSARY_TAG.test(t)).map((t) => `tag ${t}`),
    ]).join('; ') || undefined,
    attributes: {
      categories: uniq(attributes.map((a) => a.category)),
      types: uniq(attributes.map((a) => a.type)),
    },
    first_seen: seen[0] ?? undefined,
    last_seen: lastSeen[lastSeen.length - 1] ?? undefined,
  };
}
