import type { Prisma } from '../db.js';
import type { DockerExecutor } from '../docker/executor.js';
import { artifactKey, type ArtifactStore } from '../storage/index.js';
import { failOrRetry, type TransitionDeps } from './transitions.js';

export interface ProcessorDeps extends TransitionDeps {
  executor: DockerExecutor;
  artifacts: ArtifactStore;
  workerId: string;
  heartbeatIntervalMs: number;
}

/**
 * Handles one queue delivery: claim the job, run its container, record the result.
 * Never throws for job-level failures — those become job state. It throws only if
 * the database itself is unreachable, in which case the queue's redelivery and the
 * reaper recover the job.
 */
export async function processJob(jobId: string, deps: ProcessorDeps): Promise<void> {
  const { prisma, logger, workerId } = deps;
  const log = logger.child({ jobId });

  // Atomic claim. Fails if the job was cancelled, already claimed (duplicate
  // delivery), or doesn't exist — in all cases there is nothing to do.
  const claim = await prisma.job.updateMany({
    where: { id: jobId, status: 'QUEUED' },
    data: { status: 'RUNNING', workerId, startedAt: new Date(), heartbeatAt: new Date() },
  });
  if (claim.count === 0) {
    log.info('job not claimable (cancelled, duplicate delivery, or already done); skipping');
    return;
  }

  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const owned: Prisma.JobWhereInput = { workerId };
  log.info({ image: job.image, attempt: job.retryCount + 1 }, 'job claimed');

  // Heartbeat while running. If the update matches nothing, this worker no longer
  // owns a RUNNING job (cancelled by a user, or reaped as stale) — kill the container.
  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    prisma.job
      .updateMany({ where: { id: jobId, status: 'RUNNING', workerId }, data: { heartbeatAt: new Date() } })
      .then(({ count }) => {
        if (count === 0 && !abort.signal.aborted) {
          log.info('job no longer owned by this worker; stopping container');
          abort.abort();
        }
      })
      .catch((err: unknown) => log.warn({ err }, 'heartbeat failed'));
  }, deps.heartbeatIntervalMs);

  try {
    const inputFiles = await Promise.all(
      job.inputFiles.map(async (name) => ({
        name,
        data: await deps.artifacts.get(artifactKey(job.id, 'input', name)),
      })),
    );

    const result = await deps.executor.run({
      jobId: job.id,
      image: job.image,
      input: job.input,
      inputFiles,
      cpu: job.cpu,
      memoryMb: job.memoryMb,
      timeoutSeconds: job.timeoutSeconds,
      signal: abort.signal,
    });

    switch (result.status) {
      case 'succeeded': {
        for (const file of result.outputFiles) {
          await deps.artifacts.put(artifactKey(job.id, 'output', file.name), file.data);
        }
        const { count } = await prisma.job.updateMany({
          where: { ...owned, id: jobId, status: 'RUNNING' },
          data: {
            status: 'SUCCEEDED',
            output: (result.output ?? undefined) as Prisma.InputJsonValue | undefined,
            outputFiles: result.outputFiles.map((f) => f.name),
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            error: null,
            completedAt: new Date(),
          },
        });
        if (count === 0) log.info('job finished but was cancelled meanwhile; result discarded');
        else log.info('job succeeded');
        return;
      }
      case 'cancelled':
        // Status is already CANCELLED; keep the partial logs for debugging.
        await prisma.job.updateMany({
          where: { id: jobId, status: 'CANCELLED' },
          data: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
        });
        log.info('job cancelled');
        return;
      case 'failed':
      case 'timed_out':
        await failOrRetry(
          deps,
          job,
          { ...result, status: result.status === 'timed_out' ? 'TIMED_OUT' : 'FAILED' },
          owned,
        );
        return;
    }
  } catch (err) {
    // Platform-side error (storage, database). Treat as a retryable failure.
    log.error({ err }, 'unexpected error while processing job');
    await failOrRetry(
      deps,
      job,
      { status: 'FAILED', error: `Internal error: ${(err as Error).message}`, retryable: true },
      owned,
    );
  } finally {
    clearInterval(heartbeat);
  }
}
