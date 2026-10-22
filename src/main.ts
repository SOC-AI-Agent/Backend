import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

// audit_logs.id is a bigint; without this JSON.stringify throws on serialization.
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

async function bootstrapWorker() {
  const logger = new Logger('Worker');
  await NestFactory.createApplicationContext(AppModule);
  logger.log('Analysis worker started — consuming the "analysis" queue');
}

async function bootstrapApi() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // X-Forwarded-For is what nginx passes through; needed for accurate audit IPs.
  app.getHttpAdapter().getInstance().set('trust proxy', true);

  app.enableCors({
    origin: config.get<string[]>('app.allowedOrigins'),
    credentials: true,
    methods: '*',
    allowedHeaders: '*',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const swagger = new DocumentBuilder()
    .setTitle(config.get<string>('app.appName'))
    .setDescription(
      [
        'Central backend for alert triage jobs.',
        '',
        '**How a job moves.** `POST /v1/analyze` returns a `job_id` at once. Stage 1 gathers context ' +
          '(indicators, ThreatQ, the matching playbook), then two agents with no tools write the suggestion ' +
          'and what to ask Splunk. Searching Splunk is a separate, later step (`POST /v1/jobs/{job_id}/lookup`): ' +
          'the backend writes each search itself, and a third agent with no tools reads the results and writes ' +
          '`final_analysis`, citing them as `[splunk N]`.',
        '',
        '**Two ways to sign in.** SOAR and other callers send `X-API-Key` (create one at `POST /admin/api-keys`). ' +
          'Dashboard users sign in at `POST /auth/login` and send the token as `Authorization: Bearer …`. ' +
          'Use **Authorize** above; each operation shows which one it needs.',
        '',
        '**Errors** are always `{ "detail": "…" }`.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'X-API-Key')
    .addTag('Analysis', 'Submit an alert and read the job: the suggestion, the Splunk results, the analysis.')
    .addTag('Authentication', 'Sign in for the dashboard.')
    .addTag('Admin', 'Users, API keys, the audit log and the counters. Admin (and, for keys and stats, analyst) only.')
    .addTag('System', 'Health.')
    .addTag('Internal', 'Diagnostics that are off unless enabled.')
    .addTag('Splunk', "Splunk's Text-to-SPL by hand: one requirement in, the SPL Splunk writes out. Nothing is searched.")
    .build();
  // persistAuthorization: a page reload does not throw the token away.
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger), {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = config.get<number>('app.port');
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`API listening on :${port}`);
}

void (process.env.APP_ROLE === 'worker' ? bootstrapWorker() : bootstrapApi());
