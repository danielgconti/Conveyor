import { describe, expect, it } from 'vitest';
import { isTerminal, retryDelayMs, shouldRetry } from '../src/domain/lifecycle.js';

describe('shouldRetry', () => {
  it('retries retryable failures while attempts remain', () => {
    expect(shouldRetry({ retryCount: 0, maxRetries: 2, retryable: true })).toBe(true);
    expect(shouldRetry({ retryCount: 1, maxRetries: 2, retryable: true })).toBe(true);
    expect(shouldRetry({ retryCount: 2, maxRetries: 2, retryable: true })).toBe(false);
  });

  it('never retries non-retryable failures', () => {
    expect(shouldRetry({ retryCount: 0, maxRetries: 5, retryable: false })).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially and caps at one minute', () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n, 1000))).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(20, 1000)).toBe(60_000);
  });
});

describe('isTerminal', () => {
  it('distinguishes terminal states', () => {
    expect(isTerminal('QUEUED')).toBe(false);
    expect(isTerminal('RUNNING')).toBe(false);
    expect(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].every((s) => isTerminal(s as never))).toBe(true);
  });
});
