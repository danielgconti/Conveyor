import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Logger } from '../logger.js';
import type { JobQueue } from './index.js';

const MAX_SQS_DELAY_SECONDS = 900;

/**
 * SQS-backed queue for the AWS deployment. Each consumer slot long-polls for one
 * message, runs the handler, then deletes the message. If the handler throws,
 * the message is left alone and becomes visible again after the visibility timeout.
 *
 * Set the queue's visibility timeout above MAX_TIMEOUT_SECONDS. A redelivered
 * message for a job that is already RUNNING fails the claim and is dropped.
 */
export class SqsJobQueue implements JobQueue {
  private readonly client: SQSClient;
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];

  constructor(
    private readonly queueUrl: string,
    region: string | undefined,
    private readonly logger: Logger,
  ) {
    this.client = new SQSClient({ region });
  }

  async enqueue(jobId: string, options: { delayMs?: number } = {}): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ jobId }),
        DelaySeconds: Math.min(MAX_SQS_DELAY_SECONDS, Math.ceil((options.delayMs ?? 0) / 1000)),
      }),
    );
  }

  consume(handler: (jobId: string) => Promise<void>, options: { concurrency: number }): void {
    for (let i = 0; i < options.concurrency; i++) {
      this.loops.push(this.pollLoop(handler));
    }
  }

  private async pollLoop(handler: (jobId: string) => Promise<void>): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const { Messages } = await this.client.send(
          new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20 }),
          { abortSignal: this.abort.signal },
        );
        const message = Messages?.[0];
        if (!message?.Body) continue;

        const { jobId } = JSON.parse(message.Body) as { jobId: string };
        await handler(jobId);
        await this.client.send(
          new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      } catch (err) {
        if (this.abort.signal.aborted) return;
        this.logger.error({ err }, 'sqs poll loop error');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  async close(): Promise<void> {
    // Aborts in-progress long polls; handlers already running are awaited below.
    this.abort.abort();
    await Promise.allSettled(this.loops);
    this.client.destroy();
  }
}
