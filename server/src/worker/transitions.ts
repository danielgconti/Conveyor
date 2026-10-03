import type { Prisma, PrismaClient } from '../db.js';
import { retryDelayMs, shouldRetry } from '../domain/lifecycle.js';
import type { Logger } from '../logger.js';
import type { JobQueue } from '../queue/index.js';

export interface TransitionDeps {
  prisma: PrismaClient;
  queue: JobQueue;
  logger: Logger;
  retryBaseDelayMs: number;
}

export interface Failure {
  status: 'FAILED' | 'TIMED_OUT';
  error: string;
  retryable: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

/**
 * Ends a RUNNING attempt that did not succeed: either re-queues the job (retries
 * remaining and the failure is retryable) or marks it terminally FAILED/TIMED_OUT.
 *
 * `guard` narrows the update (e.g. to the owning worker, or to a stale heartbeat)
 * so a job that was cancelled or reassigned meanwhile is left untouched.
 */
export async function failOrRetry(
  deps: TransitionDeps,
  job: { id: string; retryCount: number; maxRetries: number },
  failure: Failure,
  guard: Prisma.JobWhereInput = {},
): Promise<'retried' | 'failed' | 'skipped'> {
  const where: Prisma.JobWhereInput = { ...guard, id: job.id, status: 'RUNNING' };
  const logs = { exitCode: failure.exitCode ?? null, stdout: failure.stdout ?? null, stderr: failure.stderr ?? null };
  const log = deps.logger.child({ jobId: job.id });

  if (shouldRetry({ ...job, retryable: failure.retryable })) {
    const retryNumber = job.retryCount + 1;
    const { count } = await deps.prisma.job.updateMany({
      where,
      data: {
        ...logs,
        status: 'QUEUED',
        retryCount: retryNumber,
        error: `Attempt ${retryNumber} of ${job.maxRetries + 1} failed: ${failure.error}`,
        workerId: null,
        heartbeatAt: null,
      },
    });
    if (count === 0) return 'skipped';

    const delayMs = retryDelayMs(retryNumber, deps.retryBaseDelayMs);
    try {
      await deps.queue.enqueue(job.id, { delayMs });
      log.warn({ retryNumber, delayMs, error: failure.error }, 'job failed, retry scheduled');
      return 'retried';
    } catch (err) {
      log.error({ err }, 'failed to re-enqueue job for retry');
      await deps.prisma.job.updateMany({
        where: { id: job.id, status: 'QUEUED' },
        data: { status: 'FAILED', error: `${failure.error} (retry could not be enqueued)`, completedAt: new Date() },
      });
      return 'failed';
    }
  }

  const { count } = await deps.prisma.job.updateMany({
    where,
    data: { ...logs, status: failure.status, error: failure.error, completedAt: new Date() },
  });
  if (count === 0) return 'skipped';
  log.warn({ status: failure.status, error: failure.error }, 'job failed');
  return 'failed';
}
