import { Module, Provider } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { MaintenanceService } from './maintenance.service';

const providers: Provider[] = process.env.APP_ROLE === 'worker' ? [MaintenanceService] : [];

@Module({
  imports: [ScheduleModule.forRoot()],
  providers,
})
export class MaintenanceModule {}
