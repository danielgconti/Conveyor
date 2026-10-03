import type { Job } from '../db.js';

/** Wall-clock time of the latest attempt; still ticking for a RUNNING job. */
function durationMs(job: Job): number | null {
  if (!job.startedAt) return null;
  const end = job.completedAt ?? (job.status === 'RUNNING' ? new Date() : null);
  return end ? end.getTime() - job.startedAt.getTime() : null;
}

export function toJobSummary(job: Job) {
  return {
    id: job.id,
    status: job.status,
    image: job.image,
    retryCount: job.retryCount,
    maxRetries: job.maxRetries,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    durationMs: durationMs(job),
  };
}

export function toJobDetail(job: Job) {
  return {
    ...toJobSummary(job),
    input: job.input,
    inputFiles: job.inputFiles,
    output: job.output,
    outputFiles: job.outputFiles,
    error: job.error,
    exitCode: job.exitCode,
    stdout: job.stdout,
    stderr: job.stderr,
    resources: { cpu: job.cpu, memoryMb: job.memoryMb, timeoutSeconds: job.timeoutSeconds },
    workerId: job.workerId,
    updatedAt: job.updatedAt.toISOString(),
  };
}
