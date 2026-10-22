import { BadGatewayException, Body, Controller, HttpCode, Logger, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadGatewayResponse, ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';

import { ApiRoleAuth } from '../../common/decorators/api-docs.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ErrorResponse } from '../../common/dto/error.response';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SplunkMcpService, SplunkSession } from '../enrichment/splunk-mcp.service';
import { TextToSplDto } from './dto/text-to-spl.dto';
import { TextToSplResponse } from './dto/text-to-spl.response';

/**
 * Splunk's Text-to-SPL by hand, from the API docs: a requirement in, the SPL
 * Splunk writes for it out — the first half of a stage-2 lookup, with the same
 * prompt, MCP connection, token, CA and guard, and nothing searched. For trying
 * requirements before the whole pipeline is in place.
 */
@ApiTags('Splunk')
@Controller('v1/splunk')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SplunkController {
  private readonly logger = new Logger(SplunkController.name);

  constructor(private readonly splunk: SplunkMcpService) {}

  @Post('text-to-spl')
  @HttpCode(200)
  @Roles('admin', 'analyst')
  @ApiRoleAuth('admin', 'analyst')
  @ApiOperation({
    summary: "Ask Splunk's Text-to-SPL for the SPL of one requirement",
    description:
      'Sends the requirement to `saia_generate_spl` exactly as a stage-2 lookup would — with the details, ' +
      'index, sourcetype and time range given — and returns the SPL Splunk wrote and whether the guard would ' +
      'run it. Nothing is searched. The text goes to Splunk AI Assistant, which processes it in Splunk Cloud.',
  })
  @ApiOkResponse({ type: TextToSplResponse })
  @ApiBadRequestResponse({ type: ErrorResponse, description: 'No requirement, or a field of the wrong type.' })
  @ApiBadGatewayResponse({
    type: ErrorResponse,
    description: "Splunk's MCP server could not be reached, refused the token, has no Text-to-SPL tool, or returned no SPL.",
  })
  async textToSpl(@Body() body: TextToSplDto, @Req() req: Request): Promise<TextToSplResponse> {
    const user = (req as Request & { user?: { username?: string } }).user?.username ?? '?';
    // Only flat text values: they are written into the prompt as "- key: value" lines.
    const context = Object.fromEntries(
      Object.entries(body.details ?? {})
        .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
        .map(([k, v]) => [k, String(v)]),
    );
    let session: SplunkSession | undefined;
    try {
      session = await this.splunk.connect();
      const draft = await session.generate({
        requirement: body.requirement,
        index: body.index,
        sourcetype: body.sourcetype,
        context,
        earliest: body.earliest,
        latest: body.latest,
      });
      this.logger.log(`${user} asked Text-to-SPL for "${body.requirement.slice(0, 80)}": ${draft.spl ?? `refused — ${draft.refused}`}`);
      return {
        prompt: draft.prompt,
        generated_spl: draft.generated,
        spl: draft.spl ?? null,
        refused: draft.refused ?? null,
        searched: false,
      };
    } catch (err: any) {
      throw new BadGatewayException(err?.message ?? String(err));
    } finally {
      await session?.close().catch(() => undefined);
    }
  }
}
