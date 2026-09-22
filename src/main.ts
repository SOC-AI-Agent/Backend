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
    .setDescription('SOC AI Suggestion API — central backend for alert triage jobs')
    .setVersion('1.0.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'X-API-Key')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  const port = config.get<number>('app.port');
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`API listening on :${port}`);
}

void (process.env.APP_ROLE === 'worker' ? bootstrapWorker() : bootstrapApi());
