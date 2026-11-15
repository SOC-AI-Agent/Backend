import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { indicatorRegistry } from './indicator-registry';
import { Indicator } from './ioc.service';

export interface ThreatQRecord {
  value: string;
  type: string;
  found: boolean;
  id?: number | string;
  score?: number | string;
  status?: string;
  sources?: string[];
  adversaries?: string[];
  attributes?: Record<string, unknown>;
  first_seen?: string;
  last_seen?: string;
}

export interface ThreatQResult {
  available: boolean;
  /** Only indicators with a record. An indicator ThreatQ has never seen is not
   *  evidence of anything and does not belong in a findings list. */
  hits: ThreatQRecord[];
  /** Indicators ThreatQ answered for, record or not. */
  checked: number;
  /** Indicators whose lookup failed; `error` says why. */
  failed?: number;
  error?: string;
}

class ThreatQError extends Error {}

// Refresh this long before the stated expiry, so a token never runs out mid-lookup.
const EXPIRY_MARGIN_MS = 60_000;
// Lookups in flight at once. An alert carries a handful of indicators; this keeps
// the load on ThreatQ small without making them wait in single file.
const CONCURRENCY = 5;

/**
 * Indicator reputation, looked up before the model runs, straight from ThreatQ.
 *
 * Deliberately not a tool the agent calls. Looking up every external indicator
 * in an alert is cheap, always worth doing, and has one right answer — there is
 * nothing for a model to decide, so deciding is only a chance to skip it.
 *
 * Read-only: the only calls are the token exchange and the indicator search.
 *
 * UNVERIFIED against a live instance from this repo: the password grant
 * (POST /api/token, grant_type=password + client_id) and the search
 * (POST /api/indicators/search) follow ThreatQ's REST API Reference v5.12. A
 * deployment that issues flat API tokens sets THREATQ_AUTH_MODE=bearer.
 */
@Injectable()
export class ThreatQService {
  private readonly logger = new Logger(ThreatQService.name);
  private accessToken?: string;
  private expiresAt = 0;
  /** The token request in flight, shared so parallel lookups mint one token, not five. */
  private minting?: Promise<string>;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    const c = this.config.get('enrichment.threatq');
    if (!c.baseUrl) return false;
    return c.authMode === 'bearer' ? Boolean(c.token) : Boolean(c.clientId && c.email && c.password);
  }

  async lookup(indicators: Indicator[]): Promise<ThreatQResult> {
    const types = indicatorRegistry().types;
    const lookupable = indicators.filter((i) => types[i.type]?.threatIntel);

    if (!this.enabled) {
      return { available: false, hits: [], checked: 0, error: 'ThreatQ is not configured' };
    }
    if (lookupable.length === 0) {
      return { available: true, hits: [], checked: 0 };
    }

    const { maxIndicators } = this.config.get('enrichment.threatq');
    const batch = lookupable.slice(0, maxIndicators);
    if (batch.length < lookupable.length) {
      this.logger.warn(
        `capping ThreatQ lookup at ${maxIndicators} of ${lookupable.length} indicators`,
      );
    }

    // One indicator failing must not lose the rest: the summary reports what was
    // checked and says so for the remainder.
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

    if (errors.length) this.logger.error(`ThreatQ lookup: ${errors.length} of ${batch.length} failed: ${errors[0]}`);
    // Enrichment failing must not fail the job: the alert still deserves an
    // answer, and the summary says the lookup did not happen rather than
    // implying the indicators came back clean.
    if (records.length === 0 && errors.length) {
      return { available: false, hits: [], checked: 0, failed: errors.length, error: errors[0] };
    }
    return {
      available: true,
      checked: records.length,
      hits: records.filter((r) => r.found),
      ...(errors.length ? { failed: errors.length, error: errors[0] } : {}),
    };
  }

  /**
   * One indicator. A record with `found: false` when ThreatQ has none — "never
   * seen" is an answer, and not the same as "clean".
   *
   * Searched by value alone. The indicator kinds here (ip, hash, ...) are not
   * ThreatQ's type names ("IP Address", "SHA-256", ...), and a value is
   * specific enough on its own.
   */
  private async search(type: string, value: string): Promise<ThreatQRecord> {
    const { baseUrl, searchPath, searchWith, timeoutMs } = this.config.get('enrichment.threatq');
    const post = async (force: boolean) =>
      firstValueFrom(
        this.http.post(
          `${baseUrl}${searchPath}`,
          { criteria: { value } },
          {
            params: { with: searchWith, limit: 1 },
            headers: { Authorization: `Bearer ${await this.token(force)}` },
            timeout: timeoutMs,
            validateStatus: () => true,
          },
        ),
      ).catch((err) => {
        throw new ThreatQError(`cannot reach ThreatQ at ${baseUrl}: ${err?.message ?? err}`);
      });

    let resp = await post(false);
    // The token expired between minting and using it. One retry on a fresh one,
    // because the alternative is reporting an indicator as unknown for a reason
    // that has nothing to do with ThreatQ.
    if (resp.status === 401 && this.config.get('enrichment.threatq.authMode') === 'oauth') {
      resp = await post(true);
    }

    // 404 is documented as "Object not found".
    if (resp.status === 404) return { type, value, found: false };
    if (resp.status === 401) throw new ThreatQError('ThreatQ rejected the credentials (401)');
    if (resp.status === 403) throw new ThreatQError('ThreatQ refused the search (403) — the account needs read access to indicators');
    if (resp.status >= 400) throw new ThreatQError(`ThreatQ returned ${resp.status} for ${searchPath}`);
    if (typeof resp.data !== 'object' || resp.data === null) {
      throw new ThreatQError('ThreatQ returned a non-JSON body — is THREATQ_BASE_URL behind a login page?');
    }

    // Records come back under `data`. An empty array is the other way a miss is
    // reported, so both shapes mean the same thing here.
    const data = resp.data.data;
    const entry = Array.isArray(data) ? data[0] : data;
    if (!entry || typeof entry !== 'object' || Object.keys(entry).length === 0) {
      return { type, value, found: false };
    }
    return toRecord(type, value, entry);
  }

  /** The bearer for ThreatQ: the static token, or one minted and cached. */
  private async token(force: boolean): Promise<string> {
    const c = this.config.get('enrichment.threatq');
    if (c.authMode === 'bearer') return c.token;
    if (!force && this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    this.minting ??= this.mint().finally(() => (this.minting = undefined));
    return this.minting;
  }

  private async mint(): Promise<string> {
    const c = this.config.get('enrichment.threatq');
    // ThreatQ's reference shows grant_type and client_id as query parameters and
    // does not say how the body is encoded, so they go in both places: whichever
    // one the server reads, they are there.
    const form = new URLSearchParams({
      grant_type: 'password',
      client_id: c.clientId,
      email: c.email,
      password: c.password,
    });
    const resp = await firstValueFrom(
      this.http.post(`${c.baseUrl}${c.tokenPath}`, form.toString(), {
        params: { grant_type: 'password', client_id: c.clientId },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: c.timeoutMs,
        validateStatus: () => true,
      }),
    ).catch((err) => {
      throw new ThreatQError(`cannot reach ThreatQ at ${c.baseUrl}: ${err?.message ?? err}`);
    });

    // The body is never echoed: a failed password grant can repeat the
    // submitted credentials back.
    if (resp.status === 400 || resp.status === 401) {
      throw new ThreatQError(
        `ThreatQ rejected the credentials (${resp.status}) — check THREATQ_CLIENT_ID, THREATQ_EMAIL and THREATQ_PASSWORD`,
      );
    }
    if (resp.status >= 400) throw new ThreatQError(`ThreatQ token endpoint returned ${resp.status}`);
    const token = resp.data?.access_token;
    if (typeof token !== 'string' || !token) {
      throw new ThreatQError('ThreatQ token response carried no access_token');
    }
    const ttlMs = Number(resp.data?.expires_in ?? 3600) * 1000;
    this.accessToken = token;
    this.expiresAt = Date.now() + Math.max(ttlMs - EXPIRY_MARGIN_MS, 60_000);
    this.logger.log('minted a ThreatQ access token');
    return token;
  }
}

/** Related objects come back as objects with a `name`; some deployments flatten them to strings. */
const nameOf = (item: any): any => (item && typeof item === 'object' ? item.name ?? item : item);

function toRecord(type: string, value: string, entry: any): ThreatQRecord {
  // `score` is an object when asked for by name, a number when the deployment
  // flattens it.
  let score = entry.score;
  if (score && typeof score === 'object') score = score.generated_score ?? score.score ?? score.value;

  const attributes: Record<string, unknown> = {};
  for (const a of entry.attributes ?? []) {
    if (a && typeof a === 'object' && a.name) attributes[a.name] = a.value;
  }

  return {
    type,
    value,
    found: true,
    id: entry.id,
    score: score ?? undefined,
    status: nameOf(entry.status),
    sources: (entry.sources ?? []).map(nameOf),
    adversaries: (entry.adversaries ?? []).map(nameOf),
    attributes,
    first_seen: entry.created_at ?? entry.first_seen,
    last_seen: entry.updated_at ?? entry.last_seen,
  };
}
