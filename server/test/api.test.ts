import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import type { PrismaClient } from '../src/db.js';
import { LocalArtifactStore } from '../src/storage/local.js';
import { createTestPrisma, FakeQueue, silentLogger, testDatabaseUrl, testLimits } from './helpers.js';

describe.skipIf(!testDatabaseUrl)('API (requires TEST_DATABASE_URL)', () => {
  let prisma: PrismaClient;
  let artifactsDir: string;
  let queue: FakeQueue;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    prisma = createTestPrisma();
    artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'conveyor-test-'));
  });

  beforeEach(async () => {
    await prisma.job.deleteMany();
    queue = new FakeQueue();
    app = buildApp({ prisma, queue, artifacts: new LocalArtifactStore(artifactsDir), logger: silentLogger }, testLimits);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(artifactsDir, { recursive: true, force: true });
  });

  const submit = (body: unknown) => app.inject({ method: 'POST', url: '/api/jobs', payload: body as object });

  it('accepts a job, stores it as QUEUED and enqueues it', async () => {
    const res = await submit({ image: 'conveyor/cpu-worker:latest', input: { number: 100 }, resources: { memory: '256m' } });

    expect(res.statusCode).toBe(202);
    const { jobId, status } = res.json();
    expect(status).toBe('QUEUED');
    expect(res.headers.location).toBe(`/api/jobs/${jobId}`);
    expect(queue.enqueued).toEqual([{ jobId, delayMs: undefined }]);

    const job = (await app.inject({ url: `/api/jobs/${jobId}` })).json();
    expect(job).toMatchObject({
      id: jobId,
      status: 'QUEUED',
      image: 'conveyor/cpu-worker:latest',
      input: { number: 100 },
      resources: { cpu: 1, memoryMb: 256, timeoutSeconds: 60 },
      retryCount: 0,
      maxRetries: 0,
      startedAt: null,
    });
  });

  it('stores input files and serves them back', async () => {
    const res = await submit({ image: 'w', inputFiles: { 'hello.txt': Buffer.from('hi there').toString('base64') } });
    const { jobId } = res.json();

    const file = await app.inject({ url: `/api/jobs/${jobId}/files/input/hello.txt` });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('hi there');
    expect((await app.inject({ url: `/api/jobs/${jobId}/files/input/other.txt` })).statusCode).toBe(404);
  });

  it('rejects invalid requests with field-level errors', async () => {
    const res = await submit({ image: '', resources: { cpu: 99 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['image', 'resources.cpu']),
    );
    expect(await prisma.job.count()).toBe(0);
  });

  it('marks the job FAILED and returns 503 when the queue is down', async () => {
    queue.failNext = true;
    const res = await submit({ image: 'w' });
    expect(res.statusCode).toBe(503);
    const [job] = await prisma.job.findMany();
    expect(job).toMatchObject({ status: 'FAILED', error: 'Could not enqueue job' });
  });

  it('returns 404 for unknown jobs and 400 for malformed ids', async () => {
    expect((await app.inject({ url: `/api/jobs/${crypto.randomUUID()}` })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/jobs/not-a-uuid' })).statusCode).toBe(400);
  });

  it('lists jobs newest first, filters by status, and reports stats', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await submit({ image: `w${i}` })).json().jobId);
    await prisma.job.update({ where: { id: ids[0] }, data: { status: 'SUCCEEDED' } });

    const all = (await app.inject({ url: '/api/jobs' })).json();
    expect(all.total).toBe(3);
    expect(all.jobs.map((j: { image: string }) => j.image)).toEqual(['w2', 'w1', 'w0']);

    const queued = (await app.inject({ url: '/api/jobs?status=QUEUED' })).json();
    expect(queued.total).toBe(2);

    const stats = (await app.inject({ url: '/api/jobs/stats' })).json();
    expect(stats).toMatchObject({ TOTAL: 3, QUEUED: 2, SUCCEEDED: 1, RUNNING: 0 });
  });

  it('cancels queued jobs and refuses to cancel finished ones', async () => {
    const { jobId } = (await submit({ image: 'w' })).json();

    const cancelled = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED', error: 'Cancelled by user' });
    expect(cancelled.json().completedAt).not.toBeNull();

    const again = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel` });
    expect(again.statusCode).toBe(409);
  });
});
