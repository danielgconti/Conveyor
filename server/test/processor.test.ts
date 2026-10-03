import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cancelJob } from '../src/api/job-service.js';
import type { PrismaClient } from '../src/db.js';
import type { DockerExecutor, ExecutionRequest, ExecutionResult } from '../src/docker/executor.js';
import { artifactKey } from '../src/storage/index.js';
import { LocalArtifactStore } from '../src/storage/local.js';
import { processJob, type ProcessorDeps } from '../src/worker/processor.js';
import { reapStaleJobs } from '../src/worker/reaper.js';
import { createTestPrisma, FakeQueue, silentLogger, testDatabaseUrl } from './helpers.js';

const ok: ExecutionResult = {
  status: 'succeeded',
  exitCode: 0,
  output: { result: 'HELLO' },
  outputFiles: [{ name: 'out.txt', data: Buffer.from('file!') }],
  stdout: 'log',
  stderr: '',
};
const crash: ExecutionResult = {
  status: 'failed',
  error: 'Container exited with code 1',
  retryable: true,
  exitCode: 1,
  stdout: '',
  stderr: 'boom',
};

describe.skipIf(!testDatabaseUrl)('worker job processing (requires TEST_DATABASE_URL)', () => {
  let prisma: PrismaClient;
  let artifactsDir: string;
  let deps: ProcessorDeps;
  let queue: FakeQueue;
  let runs: ExecutionRequest[];

  /** Points the processor at a fake executor that returns the given results in order. */
  function executorReturning(...results: (ExecutionResult | ((req: ExecutionRequest) => Promise<ExecutionResult>))[]) {
    deps.executor = {
      run: async (req: ExecutionRequest) => {
        runs.push(req);
        const next = results.shift();
        if (!next) throw new Error('unexpected extra run');
        return typeof next === 'function' ? next(req) : next;
      },
    } as unknown as DockerExecutor;
  }

  const createJob = (data: { maxRetries?: number; status?: 'QUEUED' | 'CANCELLED' } = {}) =>
    prisma.job.create({
      data: { image: 'example:latest', input: { text: 'hello' }, cpu: 1, memoryMb: 128, timeoutSeconds: 5, ...data },
    });

  beforeAll(async () => {
    prisma = createTestPrisma();
    artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'conveyor-test-'));
  });

  beforeEach(async () => {
    await prisma.job.deleteMany();
    queue = new FakeQueue();
    runs = [];
    deps = {
      prisma,
      queue,
      logger: silentLogger,
      artifacts: new LocalArtifactStore(artifactsDir),
      workerId: 'worker-1',
      heartbeatIntervalMs: 50,
      retryBaseDelayMs: 1000,
      executor: undefined as unknown as DockerExecutor,
    };
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it('runs a queued job to SUCCEEDED and stores its output', async () => {
    const job = await createJob();
    executorReturning(ok);

    await processJob(job.id, deps);

    const done = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(done).toMatchObject({
      status: 'SUCCEEDED',
      output: { result: 'HELLO' },
      outputFiles: ['out.txt'],
      exitCode: 0,
      stdout: 'log',
      workerId: 'worker-1',
    });
    expect(done.startedAt).not.toBeNull();
    expect(done.completedAt).not.toBeNull();
    expect(runs[0]).toMatchObject({ image: 'example:latest', input: { text: 'hello' }, memoryMb: 128 });
    expect((await deps.artifacts.get(artifactKey(job.id, 'output', 'out.txt'))).toString()).toBe('file!');
  });

  it('ignores deliveries for jobs that are not QUEUED (duplicates, cancelled)', async () => {
    const job = await createJob({ status: 'CANCELLED' });
    executorReturning();
    await processJob(job.id, deps);
    await processJob(crypto.randomUUID(), deps);
    expect(runs).toHaveLength(0);
  });

  it('re-queues retryable failures with backoff until retries run out', async () => {
    const job = await createJob({ maxRetries: 1 });
    executorReturning(crash, crash);

    await processJob(job.id, deps);
    let current = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(current).toMatchObject({ status: 'QUEUED', retryCount: 1, workerId: null, stderr: 'boom' });
    expect(current.error).toMatch(/^Attempt 1 of 2 failed/);
    expect(queue.enqueued).toEqual([{ jobId: job.id, delayMs: 1000 }]);

    await processJob(job.id, deps);
    current = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(current).toMatchObject({ status: 'FAILED', retryCount: 1, error: 'Container exited with code 1' });
    expect(current.completedAt).not.toBeNull();
    expect(queue.enqueued).toHaveLength(1);
  });

  it('fails immediately on non-retryable errors', async () => {
    const job = await createJob({ maxRetries: 3 });
    executorReturning({ ...crash, retryable: false, error: 'Image not found' });
    await processJob(job.id, deps);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: 'FAILED',
      retryCount: 0,
    });
    expect(queue.enqueued).toHaveLength(0);
  });

  it('marks timeouts TIMED_OUT once retries are exhausted', async () => {
    const job = await createJob();
    executorReturning({ ...crash, status: 'timed_out', error: 'Timed out after 5s', exitCode: 137 });
    await processJob(job.id, deps);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'TIMED_OUT' });
  });

  it('stops the container when the job is cancelled while running', async () => {
    const job = await createJob({ maxRetries: 2 });
    executorReturning(
      (req) =>
        new Promise((resolve) => {
          req.signal.addEventListener('abort', () =>
            resolve({ status: 'cancelled', error: 'Cancelled', retryable: false, exitCode: 137, stdout: 'partial', stderr: '' }),
          );
          // Cancel through the API code path once the job is RUNNING.
          void cancelJob(deps, job.id);
        }),
    );

    await processJob(job.id, deps);
    const done = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(done).toMatchObject({ status: 'CANCELLED', stdout: 'partial', retryCount: 0 });
    expect(queue.enqueued).toHaveLength(0);
  });

  it('reaps RUNNING jobs whose worker stopped heartbeating', async () => {
    const stale = new Date(Date.now() - 120_000);
    const retryable = await prisma.job.create({
      data: { image: 'x', input: {}, cpu: 1, memoryMb: 64, timeoutSeconds: 5, maxRetries: 1, status: 'RUNNING', workerId: 'dead', heartbeatAt: stale },
    });
    const final = await prisma.job.create({
      data: { image: 'x', input: {}, cpu: 1, memoryMb: 64, timeoutSeconds: 5, status: 'RUNNING', workerId: 'dead', heartbeatAt: stale },
    });
    const healthy = await prisma.job.create({
      data: { image: 'x', input: {}, cpu: 1, memoryMb: 64, timeoutSeconds: 5, status: 'RUNNING', workerId: 'alive', heartbeatAt: new Date() },
    });

    expect(await reapStaleJobs(deps, 60_000)).toBe(2);

    const byId = async (id: string) => (await prisma.job.findUniqueOrThrow({ where: { id } })).status;
    expect(await byId(retryable.id)).toBe('QUEUED');
    expect(await byId(final.id)).toBe('FAILED');
    expect(await byId(healthy.id)).toBe('RUNNING');
    expect(queue.enqueued.map((e) => e.jobId)).toEqual([retryable.id]);
  });
});
