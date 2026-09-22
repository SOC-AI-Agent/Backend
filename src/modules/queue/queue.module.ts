import { BullModule } from '@nestjs/bullmq';
import { Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AiModule } from '../ai/ai.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { AnalysisProcessor } from './analysis.processor';
import { ANALYSIS_QUEUE } from './analysis-job.payload';
import { LookupProcessor } from './lookup.processor';
import { LookupRecoveryService } from './lookup-recovery.service';
import { LOOKUP_QUEUE } from './lookup-job.payload';

/** The queue consumers only run in the worker process; the API just produces. */
const workerProviders: Provider[] =
  process.env.APP_ROLE === 'worker'
    ? [AnalysisProcessor, LookupProcessor, LookupRecoveryService]
    : [];

@Module({
  imports: [EnrichmentModule, 
    AiModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host'),
          port: config.get<number>('redis.port'),
          db: config.get<number>('redis.db'),
        },
      }),
    }),
    BullModule.registerQueue({
      name: ANALYSIS_QUEUE,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    }),
    // Separate from the analysis queue on purpose: one lookup is minutes of
    // inference per requirement, and sharing a queue would put all of it in
    // front of the next alert waiting for its first answer.
    BullModule.registerQueue({
      name: LOOKUP_QUEUE,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    }),
  ],
  providers: workerProviders,
  exports: [BullModule],
})
export class QueueModule {}
