import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

export interface AiGenerateResult {
  response: string;
  model: string;
  total_duration_ms: number;
  tokens_prompt: number;
  tokens_eval: number;
  /** The agent run behind this answer, when the AI service reports one. Stored
   *  on the job so its trace can be read beside the result. */
  run_id?: string | null;
}

/**
 * Thin HTTP client for the Python AI service (../ai-service).
 *
 * The AI service owns no database, no queue and no job state. It takes a fully
 * rendered prompt and returns the model's text. Everything else — job rows,
 * retries, audit trail — stays here in the core backend. The one thing it keeps
 * is the playbook index, on its own volume, rebuilt from what this side sends.
 *
 *   POST {AI_SERVICE_URL}/analyze
 *     body  { rendered_prompt: string, agent?: string, model?: string }
 *     reply { response, model, total_duration_ms, tokens_prompt, tokens_eval }
 *
 *   GET  {AI_SERVICE_URL}/health  ->  { status: "ok" }
 *
 * Every route but /health needs `Authorization: Bearer AI_SERVICE_AUTH_TOKEN`.
 * The playbook routes on the same service are called from PlaybookService and
 * PlaybookSyncService.
 */
/** The Authorization header for a token, or none when it is unset. */
export function bearer(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  /**
   * What the agent is given: the event, then what we already established about
   * it. No instruction line — the agent's own system prompt is the instruction,
   * and it is the one thing in this pipeline a caller cannot rewrite.
   */
  buildRenderedPrompt(rawLog: string, enrichment?: string): string {
    const parts = ['--- RAW LOG ---', rawLog, '--- END OF LOG ---'];
    // Enrichment goes after the log so the model reads the event first and the
    // reputation second — the other order invites it to describe the verdict
    // and then look for a log line that fits.
    if (enrichment) parts.push('', enrichment);
    return parts.join('\n');
  }

  /**
   * Run one prompt through a named agent.
   *
   * The agent is passed explicitly rather than left to the AI service's
   * default. The two stages use different agents — one that can reach nothing
   * and one that can reach Splunk — and a default quietly applied to both is
   * how they became the same agent the last time.
   */
  async generate(
    renderedPrompt: string,
    options: { agent?: string; model?: string } = {},
  ): Promise<AiGenerateResult> {
    const { baseUrl, timeoutMs, model: defaultModel, token } = this.config.get('ai');

    try {
      const { data } = await firstValueFrom(
        this.http.post<AiGenerateResult>(
          `${baseUrl}/analyze`,
          {
            rendered_prompt: renderedPrompt,
            agent: options.agent,
            model: options.model ?? defaultModel,
          },
          { timeout: timeoutMs, headers: bearer(token) },
        ),
      );

      return {
        response: data.response ?? '',
        model: data.model ?? defaultModel,
        total_duration_ms: data.total_duration_ms ?? 0,
        tokens_prompt: data.tokens_prompt ?? 0,
        tokens_eval: data.tokens_eval ?? 0,
        run_id: data.run_id ?? null,
      };
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? err?.message ?? 'unknown error';
      this.logger.error(`AI service call failed: ${detail}`);
      throw new ServiceUnavailableException(`AI service error: ${detail}`);
    }
  }

  async healthy(): Promise<boolean> {
    const { baseUrl } = this.config.get('ai');
    try {
      const { status } = await firstValueFrom(
        this.http.get(`${baseUrl}/health`, { timeout: 5000 }),
      );
      return status === 200;
    } catch {
      return false;
    }
  }
}
