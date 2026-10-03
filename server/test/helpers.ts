import Docker from 'dockerode';
import { pino } from 'pino';
import type { JobLimits } from '../src/config.js';
import { PrismaClient } from '../src/db.js';
import type { JobQueue } from '../src/queue/index.js';

export const silentLogger = pino({ level: 'silent' });

export const testLimits: JobLimits = {
  defaultCpu: 1,
  defaultMemoryMb: 512,
  defaultTimeoutSeconds: 60,
  maxCpu: 4,
  maxMemoryMb: 4096,
  maxTimeoutSeconds: 3600,
  maxRetries: 5,
  maxInputFilesBytes: 1024,
  allowedImagePrefixes: [],
};

export const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });

export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Database-backed tests run only when TEST_DATABASE_URL is set, e.g.
 *   TEST_DATABASE_URL=postgresql://conveyor:conveyor@localhost:5432/conveyor?schema=test
 * Migrations are applied to that database/schema by test/global-setup.ts.
 */
export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({ datasourceUrl: testDatabaseUrl });
}

/** In-memory queue that records what was enqueued. */
export class FakeQueue implements JobQueue {
  enqueued: { jobId: string; delayMs?: number }[] = [];
  failNext = false;

  async enqueue(jobId: string, options: { delayMs?: number } = {}): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('queue down');
    }
    this.enqueued.push({ jobId, delayMs: options.delayMs });
  }
  consume(): void {}
  async close(): Promise<void> {}
}
