import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { AiModule } from './modules/ai/ai.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { InternalModule } from './modules/internal/internal.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { QueueModule } from './modules/queue/queue.module';
import { SplunkModule } from './modules/splunk/splunk.module';
import { StatsModule } from './modules/stats/stats.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    AuditModule,
    AuthModule,
    AiModule,
    QueueModule,
    AnalysisModule,
    UsersModule,
    ApiKeysModule,
    StatsModule,
    SplunkModule,
    HealthModule,
    InternalModule,
    MaintenanceModule,
  ],
})
export class AppModule {}
