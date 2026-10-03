// Mirrors the API's response shapes (server/src/api/serialize.ts).

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const ACTIVE_STATUSES: readonly JobStatus[] = ['QUEUED', 'RUNNING'];

export interface JobSummary {
  id: string;
  status: JobStatus;
  image: string;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface JobDetail extends JobSummary {
  input: Record<string, unknown>;
  inputFiles: string[];
  output: unknown;
  outputFiles: string[];
  error: string | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  resources: { cpu: number; memoryMb: number; timeoutSeconds: number };
  workerId: string | null;
  updatedAt: string;
}

export type JobStats = Record<JobStatus | 'TOTAL', number>;

export interface CreateJobRequest {
  image: string;
  input: Record<string, unknown>;
  inputFiles?: Record<string, string>;
  resources: { cpu: number; memory: string; timeout: number };
  maxRetries: number;
}
