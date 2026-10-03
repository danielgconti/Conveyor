import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from '../logger.js';
import type { JobQueue } from './index.js';

const QUEUE_NAME = 'conveyor-jobs';

interface JobMessage {
  jobId: string;
}

function connectionFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    // Required by BullMQ workers (blocking commands must not time out).
    maxRetriesPerRequest: null,
  };
}

export class BullMqJobQueue implements JobQueue {
  private readonly connection: ConnectionOptions;
  private readonly queue: Queue<JobMessage>;
  private worker?: Worker<JobMessage>;

  constructor(
    redisUrl: string,
    private readonly logger: Logger,
  ) {
    this.connection = connectionFromUrl(redisUrl);
    this.queue = new Queue<JobMessage>(QUEUE_NAME, { connection: this.connection });
  }

  async enqueue(jobId: string, options: { delayMs?: number } = {}): Promise<void> {
    await this.queue.add(
      'run',
      { jobId },
      {
        delay: options.delayMs,
        // Retries are owned by the platform (see worker/transitions.ts) so they
        // behave the same on SQS; BullMQ delivers each message once.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 1000,
      },
    );
  }

  consume(handler: (jobId: string) => Promise<void>, options: { concurrency: number }): void {
    this.worker = new Worker<JobMessage>(QUEUE_NAME, (message) => handler(message.data.jobId), {
      connection: this.connection,
      concurrency: options.concurrency,
    });
    this.worker.on('failed', (message, err) =>
      this.logger.error({ err, jobId: message?.data.jobId }, 'queue handler threw'),
    );
    this.worker.on('error', (err) => this.logger.error({ err }, 'bullmq worker error'));
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
