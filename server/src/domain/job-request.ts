import { z } from 'zod';
import type { JobLimits } from '../config.js';

/**
 * Accepts "512m", "2g", "512" (MB) or a number of MB. Returns whole megabytes,
 * or null if the value can't be parsed.
 */
export function parseMemoryMb(value: string | number): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  const match = /^(\d+)\s*([mg]b?)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'm').toLowerCase()[0];
  const mb = unit === 'g' ? amount * 1024 : amount;
  return mb > 0 ? mb : null;
}

// Loose image reference check: registry/name:tag or name@sha256:digest. Docker
// does the authoritative parsing; this just rejects obvious garbage early.
const IMAGE_REF = /^[a-z0-9][a-z0-9._\-/]*(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

// Input file names become paths under /job/input/ — no directories, no traversal.
export const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function base64DecodedSize(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export function createJobRequestSchema(limits: JobLimits) {
  return z
    .object({
      image: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .regex(IMAGE_REF, 'must be a valid Docker image reference, e.g. "my-worker:latest"')
        .refine(
          (image) =>
            limits.allowedImagePrefixes.length === 0 ||
            limits.allowedImagePrefixes.some((prefix) => image.startsWith(prefix)),
          { message: 'image is not in the allowed list for this deployment' },
        ),
      /** Written verbatim to /job/input.json inside the container. */
      input: z.record(z.string(), z.unknown()).default({}),
      /** filename -> base64 content; written to /job/input/<filename>. */
      inputFiles: z
        .record(
          z.string().regex(SAFE_FILENAME, 'file names may only contain letters, digits, ".", "_" and "-"'),
          z.string().regex(BASE64, 'file contents must be base64-encoded'),
        )
        .default({})
        .refine(
          (files) =>
            Object.values(files).reduce((sum, b64) => sum + base64DecodedSize(b64), 0) <=
            limits.maxInputFilesBytes,
          { message: `input files may total at most ${limits.maxInputFilesBytes} bytes` },
        ),
      resources: z
        .object({
          cpu: z.number().positive().max(limits.maxCpu).default(limits.defaultCpu),
          memory: z
            .union([z.string(), z.number()])
            .transform((value, ctx) => {
              const mb = parseMemoryMb(value);
              if (mb === null) {
                ctx.addIssue({ code: 'custom', message: 'memory must look like "512m", "1g" or a number of MB' });
                return z.NEVER;
              }
              return mb;
            })
            .pipe(z.number().min(6, 'memory must be at least 6m').max(limits.maxMemoryMb))
            .default(limits.defaultMemoryMb),
          timeout: z.number().int().positive().max(limits.maxTimeoutSeconds).default(limits.defaultTimeoutSeconds),
        })
        .prefault({}),
      maxRetries: z.number().int().min(0).max(limits.maxRetries).default(0),
    })
    .strict();
}

export type CreateJobRequest = z.infer<ReturnType<typeof createJobRequestSchema>>;
