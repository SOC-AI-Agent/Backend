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
   */
  private async readSpace(timeoutMs: number): Promise<PlaybookPage[]> {
    const { baseUrl, apiPath, spaceKey, email, apiToken, pageLimit } = this.config.get('playbook.confluence');
    // Cloud: email + API token as basic auth. Server/DC: a personal access token as a bearer.
    const authorization = email
      ? `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
      : `Bearer ${apiToken}`;

    const raw: any[] = [];
    for (let start = 0; ; ) {
      const resp = await firstValueFrom(
        this.http.get<any>(`${baseUrl}${apiPath}/content`, {
          params: {
            spaceKey, type: 'page', status: 'current',
            expand: 'body.storage,version', limit: pageLimit, start,
          },
          headers: { Authorization: authorization, Accept: 'application/json' },
          timeout: timeoutMs,
          maxContentLength: Infinity,
          validateStatus: () => true,
        }),
      );
      if (resp.status === 401) throw new Error('Confluence rejected the credentials (401)');
      if (resp.status === 403) throw new Error(`Confluence refused the read (403) — the account cannot see space ${spaceKey}`);
      if (resp.status === 404) {
        throw new Error(`space ${spaceKey} not found (404) — or CONFLUENCE_BASE_URL is missing a path such as /wiki`);
      }
      if (resp.status >= 400) throw new Error(`Confluence returned ${resp.status}`);
      // A 200 is not proof of JSON: an SSO gateway in front of Confluence answers
      // 200 with its login page.
      const batch = resp.data?.results;
      if (!Array.isArray(batch)) {
        throw new Error('Confluence answered without a results list — is CONFLUENCE_BASE_URL behind a login page?');
      }
      raw.push(...batch);
      if (batch.length < pageLimit) break;
      start += batch.length;
    }

    return raw
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        id: String(p.id ?? ''),
        title: p.title ?? '',
        version: p.version?.number,
        url: baseUrl + (p._links?.webui ?? ''),
        body: p.body?.storage?.value ?? '',
      }));
  }
}
