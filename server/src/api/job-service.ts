import { randomUUID } from 'node:crypto';
import type { Job, JobStatus, Prisma, PrismaClient } from '../db.js';
import type { CreateJobRequest } from '../domain/job-request.js';
import { CANCELLABLE_STATUSES } from '../domain/lifecycle.js';
import type { Logger } from '../logger.js';
import type { JobQueue } from '../queue/index.js';
import { artifactKey, type ArtifactStore } from '../storage/index.js';
import { HttpError } from './http-error.js';

export interface JobServiceDeps {
  prisma: PrismaClient;
  queue: JobQueue;
  artifacts: ArtifactStore;
  logger: Logger;
}

export async function createJob(deps: JobServiceDeps, req: CreateJobRequest): Promise<Job> {
  const id = randomUUID();

  // Files go to storage first so the worker can rely on them once the row exists.
  const inputFiles = Object.entries(req.inputFiles);
  await Promise.all(
    inputFiles.map(([name, b64]) => deps.artifacts.put(artifactKey(id, 'input', name), Buffer.from(b64, 'base64'))),
  );

  const job = await deps.prisma.job.create({
    data: {
      id,
      image: req.image,
      input: req.input as Prisma.InputJsonValue,
      inputFiles: inputFiles.map(([name]) => name),
      cpu: req.resources.cpu,
      memoryMb: req.resources.memory,
      timeoutSeconds: req.resources.timeout,
      maxRetries: req.maxRetries,
    },
  });

  try {
    await deps.queue.enqueue(job.id);
  } catch (err) {
    // Don't leave a QUEUED row that nothing will ever pick up.
    deps.logger.error({ err, jobId: job.id }, 'failed to enqueue job');
    await deps.prisma.job.update({
      where: { id: job.id },
      data: { status: 'FAILED', error: 'Could not enqueue job', completedAt: new Date() },
    });
    throw new HttpError(503, 'Job queue unavailable, please retry');
  }

  deps.logger.info({ jobId: job.id, image: job.image }, 'job queued');
  return job;
}

export async function getJob(deps: JobServiceDeps, id: string): Promise<Job> {
  const job = await deps.prisma.job.findUnique({ where: { id } });
  if (!job) throw new HttpError(404, 'Job not found');
  return job;
}

export async function listJobs(
  deps: JobServiceDeps,
  filter: { status?: JobStatus; limit: number; offset: number },
): Promise<{ jobs: Job[]; total: number }> {
  const where = filter.status ? { status: filter.status } : {};
  const [jobs, total] = await deps.prisma.$transaction([
    deps.prisma.job.findMany({ where, orderBy: { createdAt: 'desc' }, take: filter.limit, skip: filter.offset }),
    deps.prisma.job.count({ where }),
  ]);
  return { jobs, total };
}

export async function getStats(deps: JobServiceDeps): Promise<Record<JobStatus | 'TOTAL', number>> {
  const groups = await deps.prisma.job.groupBy({ by: ['status'], _count: { _all: true } });
  const stats = { TOTAL: 0, QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, TIMED_OUT: 0, CANCELLED: 0 };
  for (const g of groups) {
    stats[g.status] = g._count._all;
    stats.TOTAL += g._count._all;
  }
  return stats;
}

/**
 * QUEUED jobs are simply never claimed. RUNNING jobs are stopped by their worker:
 * its next heartbeat sees it no longer owns a RUNNING job and kills the container.
 */
export async function cancelJob(deps: JobServiceDeps, id: string): Promise<Job> {
  const { count } = await deps.prisma.job.updateMany({
    where: { id, status: { in: [...CANCELLABLE_STATUSES] } },
    data: { status: 'CANCELLED', error: 'Cancelled by user', completedAt: new Date() },
  });
  const job = await getJob(deps, id);
  if (count === 0) throw new HttpError(409, `Job is already ${job.status} and cannot be cancelled`);
  deps.logger.info({ jobId: id }, 'job cancelled');
  return job;
}
