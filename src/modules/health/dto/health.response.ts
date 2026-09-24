import { ApiProperty } from '@nestjs/swagger';

export class HealthResponse {
  @ApiProperty({ example: 'ok' })
  status: string;

  /** APP_NAME. */
  app: string;

  /** OLLAMA_MODEL — what is reported, not a check that it is loaded. */
  model: string;

  /** Whether the backend could reach `soc-ai`, the service in front of the LLM server. */
  @ApiProperty({ enum: ['up', 'down'] })
  ai_service: string;
}

export class RootResponse {
  message: string;

  @ApiProperty({ example: '/docs' })
  docs: string;
}
