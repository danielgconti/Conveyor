import { pino, type Logger } from 'pino';

export type { Logger };

/** JSON logs to stdout — readable locally, and ingested as-is by CloudWatch on AWS. */
export function createLogger(service: 'api' | 'worker', level: string): Logger {
  return pino({ level, base: { service } });
}
