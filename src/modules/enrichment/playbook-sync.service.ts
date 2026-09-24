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

/**
 * Keeps soc-ai's playbook index in step with Confluence.
 *
 * Every PLAYBOOK_SYNC_MINUTES the worker reads the space through the Confluence
 * connector (GET /pages — the connector holds the Confluence credentials) and
 * sends it whole to soc-ai (PUT /playbooks/index), which extracts the fields and
 * embeds only the ones whose text changed. A sync where nothing moved embeds
 * nothing, so running it hourly costs one read of the space.
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
    const { url, syncMinutes } = this.config.get('playbook');
    if (!url) {
      this.logger.warn(
        'CONFLUENCE_MCP_URL is unset: playbooks are not synced, and every match will say nothing is indexed',
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

    const { url, token, syncTimeoutMs } = this.config.get('playbook');
    const ai = this.config.get('ai');
    let step = `reading the pages from the Confluence connector (${url}/pages)`;
    try {
      const { data: space } = await firstValueFrom(
        this.http.get<any>(`${url}/pages`, { timeout: syncTimeoutMs, headers: bearer(token) }),
      );
      const pages = Array.isArray(space?.pages) ? space.pages : null;
      if (!pages) throw new Error('the connector answered without a pages list');

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
}
