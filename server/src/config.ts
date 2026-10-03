import os from 'node:os';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    DATABASE_URL: z.string().min(1),

    // Queue: BullMQ/Redis locally, SQS on AWS.
    QUEUE_DRIVER: z.enum(['bullmq', 'sqs']).default('bullmq'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    SQS_QUEUE_URL: z.string().optional(),
    AWS_REGION: z.string().optional(),

    // Artifact storage for input/output files: local disk or S3.
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    ARTIFACTS_DIR: z.string().default('./data/artifacts'),
    S3_BUCKET: z.string().optional(),

    // API
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(3000),
    /** Comma-separated image prefixes allowed to run. Empty = any image. */
    ALLOWED_IMAGE_PREFIXES: csv.default([]),
    MAX_INPUT_FILES_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

    // Job defaults and ceilings
    DEFAULT_CPU: z.coerce.number().positive().default(1),
    DEFAULT_MEMORY_MB: z.coerce.number().int().positive().default(512),
    DEFAULT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
    MAX_CPU: z.coerce.number().positive().default(4),
    MAX_MEMORY_MB: z.coerce.number().int().positive().default(4096),
    MAX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(3600),
    MAX_RETRIES_LIMIT: z.coerce.number().int().min(0).default(5),

    // Worker
    WORKER_ID: z.string().default(`${os.hostname()}-${process.pid}`),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
    DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
    /** Docker network for job containers. "none" = no network access. */
    JOB_NETWORK_MODE: z.string().default('none'),
    /** uid:gid job containers run as. Empty string = the image's own USER. */
    JOB_CONTAINER_USER: z.string().default('65534:65534'),
    JOB_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
    PULL_MISSING_IMAGES: bool.default(false),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    /** A RUNNING job with no heartbeat for this long is considered orphaned. */
    STALE_JOB_THRESHOLD_MS: z.coerce.number().int().positive().default(60_000),
    REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(2_000),
  })
  .superRefine((env, ctx) => {
    if (env.QUEUE_DRIVER === 'sqs' && !env.SQS_QUEUE_URL) {
      ctx.addIssue({ code: 'custom', path: ['SQS_QUEUE_URL'], message: 'required when QUEUE_DRIVER=sqs' });
    }
    if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) {
      ctx.addIssue({ code: 'custom', path: ['S3_BUCKET'], message: 'required when STORAGE_DRIVER=s3' });
    }
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

/** Per-job resource bounds, derived from config, used to validate job requests. */
export interface JobLimits {
  defaultCpu: number;
  defaultMemoryMb: number;
  defaultTimeoutSeconds: number;
  maxCpu: number;
  maxMemoryMb: number;
  maxTimeoutSeconds: number;
  maxRetries: number;
  maxInputFilesBytes: number;
  allowedImagePrefixes: string[];
}

export function jobLimitsFromConfig(config: Config): JobLimits {
  return {
    defaultCpu: config.DEFAULT_CPU,
    defaultMemoryMb: config.DEFAULT_MEMORY_MB,
    defaultTimeoutSeconds: config.DEFAULT_TIMEOUT_SECONDS,
    maxCpu: config.MAX_CPU,
    maxMemoryMb: config.MAX_MEMORY_MB,
    maxTimeoutSeconds: config.MAX_TIMEOUT_SECONDS,
    maxRetries: config.MAX_RETRIES_LIMIT,
    maxInputFilesBytes: config.MAX_INPUT_FILES_BYTES,
    allowedImagePrefixes: config.ALLOWED_IMAGE_PREFIXES,
  };
}
