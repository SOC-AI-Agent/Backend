import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { Indicator } from './ioc.service';

export interface ThreatQRecord {
  value: string;
  type: string;
  found: boolean;
  score?: number;
  status?: string;
  sources?: string[];
  adversaries?: string[];
  first_seen?: string;
  last_seen?: string;
}

export interface ThreatQResult {
  available: boolean;
  /** Only indicators with a record. An indicator ThreatQ has never seen is not
   *  evidence of anything and does not belong in a findings list. */
  hits: ThreatQRecord[];
  checked: number;
  error?: string;
}

/**
 * Indicator reputation, looked up before the model runs.
 *
 * Deliberately not a tool the agent calls. Looking up every external indicator
 * in an alert is cheap, always worth doing, and has one right answer — there is
 * nothing for a model to decide, so deciding is only a chance to skip it.
 *
 * It speaks to the ThreatQ gateway's HTTP route rather than over MCP: the
 * backend has no business holding an MCP session, and the gateway already owns
 * the credentials and the write barrier.
 */
@Injectable()
export class ThreatQService {
  private readonly logger = new Logger(ThreatQService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    const { url, token } = this.config.get('enrichment.threatq');
    return Boolean(url && token);
  }

  async lookup(indicators: Indicator[]): Promise<ThreatQResult> {
    const lookupable = indicators.filter((i) =>
      ['ip', 'domain', 'url', 'hash', 'email'].includes(i.type),
    );

    if (!this.enabled) {
      return { available: false, hits: [], checked: 0, error: 'ThreatQ is not configured' };
    }
    if (lookupable.length === 0) {
      return { available: true, hits: [], checked: 0 };
    }

    const { url, token, timeoutMs, maxIndicators } = this.config.get('enrichment.threatq');
    const batch = lookupable.slice(0, maxIndicators);
    if (batch.length < lookupable.length) {
      this.logger.warn(
        `capping ThreatQ lookup at ${maxIndicators} of ${lookupable.length} indicators`,
      );
    }

    try {
      const { data } = await firstValueFrom(
        this.http.post(
          `${url.replace(/\/$/, '')}/lookup`,
          { indicators: batch.map(({ type, value }) => ({ type, value })) },
          { headers: { Authorization: `Bearer ${token}` }, timeout: timeoutMs },
        ),
      );
      const records: ThreatQRecord[] = data?.records ?? [];
      return { available: true, checked: batch.length, hits: records.filter((r) => r.found) };
    } catch (err: any) {
      // Enrichment failing must not fail the job: the alert still deserves an
      // answer, and the summary says the lookup did not happen rather than
      // implying the indicators came back clean.
      const detail = err?.response?.data?.detail ?? err?.message ?? 'unknown error';
      this.logger.error(`ThreatQ lookup failed: ${detail}`);
      return { available: false, hits: [], checked: batch.length, error: String(detail) };
    }
  }
}
