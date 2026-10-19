import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { bearer } from '../ai/ai.service';

export interface PlaybookSyncState {
  at: Date | null;
  /** null until the first sync has finished. */
  ok: boolean | null;
  error?: string;
  pages?: number;
  playbooks?: number;
  embedded?: number;
  reused?: number;
}

/** One Confluence page as soc-ai indexes it: storage-format XHTML, unparsed. */
export interface PlaybookPage {
  id: string;
  title: string;
  version?: number;
  url: string;
  body: string;
}

/**
 * Keeps soc-ai's playbook index in step with Confluence.
 *
 * Every PLAYBOOK_SYNC_MINUTES the worker reads every current page of the space
 * straight from Confluence's REST API and sends it whole to soc-ai
 * (PUT /playbooks/index), which extracts the fields and embeds only the ones
 * whose text changed. A sync where nothing moved embeds nothing, so running it
 * hourly costs one read of the space. Read-only: nothing is written to Confluence.
 *
 * A failed sync changes nothing on soc-ai: it keeps serving the last index, and
 * PlaybookService says so on every match until a sync succeeds again.
 *
 * Worker only. The API process never matches a playbook, and a sync per API
 * replica would be the same work several times over.
 */
@Injectable()
export class PlaybookSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PlaybookSyncService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  state: PlaybookSyncState = { at: null, ok: null };

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.APP_ROLE !== 'worker') return;
    const { confluence, syncMinutes } = this.config.get('playbook');
    if (!confluence.baseUrl || !confluence.apiToken || !confluence.spaceKey) {
      this.logger.warn(
        'CONFLUENCE_BASE_URL, CONFLUENCE_API_TOKEN or CONFLUENCE_SPACE_KEY is unset: playbooks ' +
          'are not synced, and every match will say nothing is indexed',
      );
      return;
    }
    // Not awaited: the first sync may be embedding a whole space, and the queue
    // should not wait for it. Alerts that arrive first are matched against
    // whatever soc-ai already had on its volume.
    void this.sync();
    this.timer = setInterval(() => void this.sync(), Math.max(syncMinutes, 1) * 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The last sync failed, so matches come from the index before it. */
  get stale(): boolean {
    return this.state.ok === false;
  }

  async sync(): Promise<PlaybookSyncState> {
    // One at a time. A slow first embed must not have the next tick start a
    // second read of the space underneath it.
    if (this.running) return this.state;
    this.running = true;

    const { confluence, syncTimeoutMs } = this.config.get('playbook');
    const ai = this.config.get('ai');
    let step = `reading space ${confluence.spaceKey} from Confluence (${confluence.baseUrl})`;
    try {
      const pages = await this.readSpace(syncTimeoutMs);

      step = `indexing ${pages.length} page(s) in soc-ai (${ai.baseUrl}/playbooks/index)`;
      const { data: result } = await firstValueFrom(
        this.http.put<any>(
          `${ai.baseUrl}/playbooks/index`,
          { source: 'confluence', pages },
          {
            timeout: syncTimeoutMs,
            headers: bearer(ai.token),
            // A space of a few hundred pages is megabytes of XHTML.
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          },
        ),
      );

      this.state = {
        at: new Date(), ok: true, pages: pages.length,
        playbooks: result?.playbooks, embedded: result?.embedded, reused: result?.reused,
      };
      const notes: string[] = [];
      if (result?.skipped?.length) notes.push(`${result.skipped.length} page(s) had no alert name`);
      if (result?.conflicts?.length) notes.push(`${result.conflicts.length} name(s) claimed by two pages`);
      if (result?.semantic?.error) notes.push(`matching by meaning is off: ${result.semantic.error}`);
      this.logger.log(
        `playbooks synced: ${pages.length} page(s), ${result?.playbooks} playbook(s); ` +
          `${result?.embedded} field(s) embedded, ${result?.reused} reused` +
          (notes.length ? ` — ${notes.join('; ')}` : ''),
      );
    } catch (err: any) {
      const said =
        err?.response?.data?.error ?? err?.response?.data?.detail ?? err?.message ?? String(err);
      this.state = { ...this.state, at: new Date(), ok: false, error: `${step}: ${said}` };
      this.logger.error(`playbook sync failed, soc-ai keeps its last index — ${step}: ${said}`);
    } finally {
      this.running = false;
    }
    return this.state;
  }

  /**
   * Every current page in the space, with its body.
   *
   * Paged through to the end rather than taking the first batch: a space that
   * grew past one page of results would otherwise lose playbooks silently, and
   * the alerts they cover would start reporting "no playbook". Throws rather
   * than returning an empty list, which soc-ai would take for an empty space.
   *
   * Public for scripts/confluence-check, which reads the space the same way.
   */
  async readSpace(timeoutMs: number): Promise<PlaybookPage[]> {
    return this.apiVersion() === 'v2' ? this.readSpaceV2(timeoutMs) : this.readSpaceV1(timeoutMs);
  }

  /**
   * Whether Confluence answers at all, with no credentials sent: the network,
   * CONFLUENCE_PROXY and the certificate, apart from the account. Resolves with
   * what it answered; rejects on a network or TLS failure. Redirects are not
   * followed, so a login page in front of the API shows as one.
   *
   * For scripts/confluence-check --network (deploy_production's last step).
   */
  async reach(timeoutMs: number): Promise<{ url: string; status: number; location?: string; html: boolean }> {
    const { baseUrl, apiPath, proxy } = this.config.get('playbook.confluence');
    const url = this.apiVersion() === 'v2' ? `${baseUrl}/api/v2/spaces` : `${baseUrl}${apiPath}/space`;
    const resp = await firstValueFrom(
      this.http.get<any>(url, {
        params: { limit: 1 },
        headers: { Accept: 'application/json' },
        timeout: timeoutMs,
        maxRedirects: 0,
        validateStatus: () => true,
        proxy: proxy ? (new URL(proxy) as any) : false,
      }),
    );
    return {
      url,
      status: resp.status,
      location: resp.headers?.location,
      html: String(resp.headers?.['content-type'] ?? '').includes('text/html'),
    };
  }

  /** v1 or v2, from CONFLUENCE_API (auto: v2 for Atlassian's cloud). */
  apiVersion(): 'v1' | 'v2' {
    const { baseUrl, api } = this.config.get('playbook.confluence');
    if (api === 'v1' || api === 'v2') return api;
    try {
      return new URL(baseUrl).hostname.endsWith('.atlassian.net') ? 'v2' : 'v1';
    } catch {
      return 'v1';
    }
  }

  /** Server/DC (and Cloud while it lasts): GET <apiPath>/content, offset paging. */
  private async readSpaceV1(timeoutMs: number): Promise<PlaybookPage[]> {
    const { baseUrl, apiPath, spaceKey, pageLimit } = this.config.get('playbook.confluence');
    const raw: any[] = [];
    for (let start = 0; ; ) {
      const data = await this.get(`${baseUrl}${apiPath}/content`, timeoutMs, {
        spaceKey, type: 'page', status: 'current',
        expand: 'body.storage,version', limit: pageLimit, start,
      });
      const batch = this.results(data);
      raw.push(...batch);
      // The end is where Confluence stops offering a next page, not the first
      // batch shorter than asked for: it may cap the page size below
      // CONFLUENCE_PAGE_LIMIT (it does when bodies are expanded), and stopping
      // there would index the first batch of the space and quietly drop the rest.
      // Without _links at all, by the page size it says it used.
      const links = data._links;
      const more = links ? Boolean(links.next) : batch.length >= (data.limit ?? pageLimit);
      if (!more || batch.length === 0) break;
      start += batch.length;
    }
    return this.toPages(raw, baseUrl);
  }

  /**
   * Cloud: the space's id from its key, then GET /api/v2/spaces/{id}/pages
   * with the bodies in storage format, following the cursor in _links.next.
   */
  private async readSpaceV2(timeoutMs: number): Promise<PlaybookPage[]> {
    const { baseUrl, spaceKey, pageLimit } = this.config.get('playbook.confluence');
    const spaces = this.results(await this.get(`${baseUrl}/api/v2/spaces`, timeoutMs, { keys: spaceKey }));
    const space = spaces.find((s) => s?.key === spaceKey) ?? spaces[0];
    if (!space?.id) {
      throw new Error(`space ${spaceKey} not found — or the account cannot see it`);
    }
    const raw: any[] = [];
    let base = baseUrl;
    let url: string | null = `${baseUrl}/api/v2/spaces/${space.id}/pages`;
    let params: Record<string, unknown> | undefined = {
      'body-format': 'storage', status: 'current', limit: Math.min(pageLimit, 250),
    };
    while (url) {
      const data = await this.get(url, timeoutMs, params);
      raw.push(...this.results(data));
      base = data._links?.base ?? base;
      // next is a path from the site's root, cursor and all.
      const next: string | undefined = data._links?.next;
      url = next ? new URL(next, baseUrl).toString() : null;
      params = undefined;
    }
    return this.toPages(raw, base);
  }

  /** One GET to Confluence: the credentials, CONFLUENCE_PROXY, and what each refusal means. */
  private async get(url: string, timeoutMs: number, params?: Record<string, unknown>): Promise<any> {
    const { spaceKey, email, apiToken, proxy } = this.config.get('playbook.confluence');
    // Cloud: email + API token as basic auth. Server/DC: a personal access token as a bearer.
    const authorization = email
      ? `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
      : `Bearer ${apiToken}`;
    const resp = await firstValueFrom(
      this.http.get<any>(url, {
        params,
        headers: { Authorization: authorization, Accept: 'application/json' },
        timeout: timeoutMs,
        maxContentLength: Infinity,
        validateStatus: () => true,
        // axios tunnels HTTPS through an HTTP proxy with CONNECT. false: no
        // proxy at all, not one picked up from the environment.
        proxy: proxy ? (new URL(proxy) as any) : false,
      }),
    );
    const via = proxy ? ', or the proxy refused' : '';
    if (resp.status === 401) throw new Error('Confluence rejected the credentials (401)');
    if (resp.status === 403) throw new Error(`Confluence refused the read (403) — the account cannot see space ${spaceKey}${via}`);
    if (resp.status === 407) throw new Error('the proxy wants credentials of its own (407): CONFLUENCE_PROXY=http://user:pass@host:port');
    if (resp.status === 404) {
      throw new Error(`not found (404) — space ${spaceKey}, or CONFLUENCE_BASE_URL is missing a path such as /wiki`);
    }
    if (resp.status >= 400) throw new Error(`Confluence returned ${resp.status}`);
    return resp.data;
  }

  /** The results list, or an error: a 200 is not proof of JSON. */
  private results(data: any): any[] {
    // An SSO gateway in front of Confluence answers 200 with its login page.
    if (!Array.isArray(data?.results)) {
      throw new Error('Confluence answered without a results list — is CONFLUENCE_BASE_URL behind a login page?');
    }
    return data.results;
  }

  private toPages(raw: any[], base: string): PlaybookPage[] {
    return raw
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        id: String(p.id ?? ''),
        title: p.title ?? '',
        version: p.version?.number,
        url: base + (p._links?.webui ?? ''),
        body: p.body?.storage?.value ?? '',
      }));
  }
}
