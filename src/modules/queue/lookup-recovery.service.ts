import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { LookupStatus } from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';
import { LOOKUP_QUEUE, SplunkLookupPayload } from './lookup-job.payload';

/**
 * Clear lookups the worker was running when it died.
 *
 * A lookup holds its state in two places: a BullMQ job and a row. Kill the
 * worker between them — a deploy, a restarted Docker daemon, a laptop going to
 * sleep — and the job is gone while the row still says RUNNING. Nothing then
 * ever changes it. The lookup is not running, will never finish, and the
 * button that would start it again is hidden precisely because the row claims
 * it is already going. The alert is stuck for good, and nothing says why.
 *
 * So at boot: anything the row calls QUEUED or RUNNING that the queue does not
 * actually hold is finished, as failed, with the reason written down. Whatever
 * answers it got before it died are already on the row and are left alone —
 * they were paid for.
 *
 * Retrying automatically would be the wrong call. Each requirement is minutes
 * of inference, and a worker that restarted may have restarted because that is
 * what the work did to it. Recovering to a state a person can act on is enough.
 */
@Injectable()
export class LookupRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LookupRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(LOOKUP_QUEUE) private readonly queue: Queue<SplunkLookupPayload>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const unfinished = await this.prisma.aiJob.findMany({
      where: { lookupStatus: { in: [LookupStatus.QUEUED, LookupStatus.RUNNING] } },
      select: { jobId: true, alertId: true, lookupStatus: true },
    });
    if (unfinished.length === 0) return;

    // Jobs genuinely still in the queue belong to this run and are left be —
    // a second worker, or a restart fast enough that the queue outlived it.
    const live = new Set(
      (await this.queue.getJobs(['waiting', 'active', 'delayed']))
        .map((job) => job.data?.jobId)
        .filter(Boolean),
    );

    const stale = unfinished.filter((job) => !live.has(job.jobId));
    if (stale.length === 0) {
      this.logger.log(`${unfinished.length} lookup(s) still queued — leaving them alone`);
      return;
    }

    await this.prisma.aiJob.updateMany({
      where: { jobId: { in: stale.map((job) => job.jobId) } },
      data: {
        lookupStatus: LookupStatus.FAILED,
        lookupError:
          'the worker stopped while this was running, so it never finished. ' +
          'Any answers below were collected before it stopped. Run it again to complete the rest.',
        lookupCompletedAt: new Date(),
      },
    });

    for (const job of stale) {
      this.logger.warn(
        `recovered ${job.alertId} (${job.jobId}): left ${job.lookupStatus} by a stopped worker`,
      );
    }
  }
}
