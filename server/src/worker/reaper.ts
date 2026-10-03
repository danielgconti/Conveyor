import type Docker from 'dockerode';
import { JOB_ID_LABEL, MANAGED_LABEL } from '../docker/executor.js';
import { failOrRetry, type TransitionDeps } from './transitions.js';

/**
 * Recovers jobs whose worker died mid-run: any RUNNING job whose heartbeat is
 * older than the threshold is failed (or re-queued if it has retries left).
 * Safe to run on every worker concurrently — each transition is a guarded update.
 */
export async function reapStaleJobs(deps: TransitionDeps, staleThresholdMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleThresholdMs);
  const stale = await deps.prisma.job.findMany({
    where: { status: 'RUNNING', heartbeatAt: { lt: cutoff } },
    select: { id: true, retryCount: true, maxRetries: true, workerId: true },
    take: 100,
  });
  for (const job of stale) {
    await failOrRetry(
      deps,
      job,
      { status: 'FAILED', error: `Worker ${job.workerId ?? 'unknown'} stopped responding`, retryable: true },
      { heartbeatAt: { lt: cutoff } },
    );
  }
  return stale.length;
}

/**
 * Removes job containers left behind on this Docker host (e.g. the worker was
 * killed mid-job) whose job is no longer RUNNING. Containers for RUNNING jobs are
 * left alone; if their worker is gone, the job is reaped first and the
 * container is removed on the next sweep.
 */
export async function removeOrphanedContainers(deps: TransitionDeps, docker: Docker): Promise<number> {
  const containers = await docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=true`] } });
  if (containers.length === 0) return 0;

  const jobIds = containers.map((c) => c.Labels[JOB_ID_LABEL]).filter((id): id is string => Boolean(id));
  const running = new Set(
    (
      await deps.prisma.job.findMany({ where: { id: { in: jobIds }, status: 'RUNNING' }, select: { id: true } })
    ).map((j) => j.id),
  );

  let removed = 0;
  for (const info of containers) {
    const jobId = info.Labels[JOB_ID_LABEL];
    if (jobId && running.has(jobId)) continue;
    await docker
      .getContainer(info.Id)
      .remove({ force: true })
      .then(() => removed++)
      .catch((err: unknown) => deps.logger.warn({ err, containerId: info.Id }, 'failed to remove orphaned container'));
  }
  if (removed > 0) deps.logger.info({ removed }, 'removed orphaned job containers');
  return removed;
}
