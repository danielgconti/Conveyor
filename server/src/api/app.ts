import path from 'node:path';
import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import type { JobLimits } from '../config.js';
import { createJobRequestSchema } from '../domain/job-request.js';
import { artifactKey } from '../storage/index.js';
import { HttpError } from './http-error.js';
import { cancelJob, createJob, getJob, getStats, listJobs, type JobServiceDeps } from './job-service.js';
import { toJobDetail, toJobSummary } from './serialize.js';

const idParams = z.object({ id: z.uuid({ message: 'invalid job id' }) });

const listQuery = z.object({
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const fileParams = idParams.extend({
  kind: z.enum(['input', 'output']),
  name: z.string(),
});

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

export function buildApp(deps: JobServiceDeps, limits: JobLimits) {
  const app = Fastify({
    loggerInstance: deps.logger,
    // Input files arrive base64-encoded (~4/3 size) inside the JSON body.
    bodyLimit: Math.ceil(limits.maxInputFilesBytes * 1.4) + 1024 * 1024,
  });
  const createJobSchema = createJobRequestSchema(limits);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'Invalid request',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) return reply.status(statusCode).send({ error: (err as Error).message });
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'Internal server error' });
  });

  app.get('/healthz', async () => {
    await deps.prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });

  app.post('/api/jobs', async (request, reply) => {
    const job = await createJob(deps, createJobSchema.parse(request.body ?? {}));
    // 202: accepted for asynchronous processing; poll the Location for status.
    return reply
      .status(202)
      .header('location', `/api/jobs/${job.id}`)
      .send({ jobId: job.id, status: job.status });
  });

  app.get('/api/jobs', async (request) => {
    const { jobs, total } = await listJobs(deps, listQuery.parse(request.query));
    return { jobs: jobs.map(toJobSummary), total };
  });

  app.get('/api/jobs/stats', async () => getStats(deps));

  app.get('/api/jobs/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    return toJobDetail(await getJob(deps, id));
  });

  app.post('/api/jobs/:id/cancel', async (request) => {
    const { id } = idParams.parse(request.params);
    return toJobDetail(await cancelJob(deps, id));
  });

  app.get('/api/jobs/:id/files/:kind/:name', async (request, reply) => {
    const { id, kind, name } = fileParams.parse(request.params);
    const job = await getJob(deps, id);
    // Only serve names recorded on the job, never arbitrary storage keys.
    const known = kind === 'input' ? job.inputFiles : job.outputFiles;
    if (!known.includes(name)) throw new HttpError(404, 'File not found');
    const stream = await deps.artifacts.stream(artifactKey(id, kind, name));
    return reply
      .type(CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream')
      .header('content-disposition', `inline; filename="${name}"`)
      .send(stream);
  });

  return app;
}
