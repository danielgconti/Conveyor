import type { JobStatus } from '../db.js';

/**
 * Job lifecycle:
 *
 *   QUEUED ──claim──▶ RUNNING ──▶ SUCCEEDED
 *     ▲                 │  ├────▶ FAILED      (non-retryable, or retries exhausted)
 *     └──── retry ──────┘  └────▶ TIMED_OUT   (retries exhausted)
 *
 *   QUEUED / RUNNING ──cancel──▶ CANCELLED
 */
export const TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'] as const satisfies JobStatus[];
export const CANCELLABLE_STATUSES = ['QUEUED', 'RUNNING'] as const satisfies JobStatus[];

export function isTerminal(status: JobStatus): boolean {
  return (TERMINAL_STATUSES as readonly JobStatus[]).includes(status);
}

export interface FailureContext {
  retryCount: number;
  maxRetries: number;
  /** False for failures a retry can't fix, e.g. a missing image or malformed output. */
  retryable: boolean;
}

export function shouldRetry({ retryCount, maxRetries, retryable }: FailureContext): boolean {
  return retryable && retryCount < maxRetries;
}

const MAX_RETRY_DELAY_MS = 60_000;

/** Exponential backoff: base, 2×base, 4×base, … capped at one minute. */
export function retryDelayMs(retryNumber: number, baseDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** Math.max(0, retryNumber - 1), MAX_RETRY_DELAY_MS);
}
