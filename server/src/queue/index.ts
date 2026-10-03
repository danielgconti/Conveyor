import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { BullMqJobQueue } from './bullmq.js';
import { SqsJobQueue } from './sqs.js';

/**
 * The queue only carries job ids. Postgres holds job state, so delivery can be
 * at-least-once: a worker atomically claims QUEUED → RUNNING before doing any work,
 * and a duplicate or stale message simply fails the claim and is dropped.
 */
export interface JobQueue {
  enqueue(jobId: string, options?: { delayMs?: number }): Promise<void>;
  /** Start delivering job ids to `handler`, with at most `concurrency` in flight. */
  consume(handler: (jobId: string) => Promise<void>, options: { concurrency: number }): void;
  /** Stop consuming, wait for in-flight handlers, and release connections. */
  close(): Promise<void>;
}

export function createJobQueue(config: Config, logger: Logger): JobQueue {
  switch (config.QUEUE_DRIVER) {
    case 'bullmq':
      return new BullMqJobQueue(config.REDIS_URL, logger);
    case 'sqs':
      return new SqsJobQueue(config.SQS_QUEUE_URL!, config.AWS_REGION, logger);
  }
}
