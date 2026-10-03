import type { Readable } from 'node:stream';
import tar from 'tar-stream';

export interface NamedFile {
  name: string;
  data: Buffer;
}

/**
 * Builds the tar archive copied into the container at "/" before it starts:
 *
 *   /job/input.json     the job's input payload
 *   /job/input/<name>   any attached input files
 *   /job/output/        empty, for the container to write files into
 *
 * Directories are world-writable because job containers run as an unprivileged
 * user by default and must be able to write /job/output.json and /job/output/.
 */
export async function buildJobArchive(input: unknown, inputFiles: NamedFile[]): Promise<Buffer> {
  const pack = tar.pack();
  pack.entry({ name: 'job', type: 'directory', mode: 0o777 });
  pack.entry({ name: 'job/input', type: 'directory', mode: 0o777 });
  pack.entry({ name: 'job/output', type: 'directory', mode: 0o777 });
  pack.entry({ name: 'job/input.json', mode: 0o644 }, JSON.stringify(input, null, 2));
  for (const file of inputFiles) {
    pack.entry({ name: `job/input/${file.name}`, mode: 0o644 }, file.data);
  }
  pack.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export class OutputLimitError extends Error {}

/**
 * Reads regular files out of a tar stream (as returned by Docker's archive API).
 * Only top-level files are kept: for `/job/output` that means `output/<name>`;
 * nested directories are ignored. Throws OutputLimitError when limits are exceeded.
 */
export async function extractFiles(
  archive: Readable,
  limits: { maxFiles: number; maxTotalBytes: number },
): Promise<NamedFile[]> {
  const extract = tar.extract();
  archive.pipe(extract);

  const files: NamedFile[] = [];
  let total = 0;
  for await (const entry of extract) {
    const { name, type, size = 0 } = entry.header;
    const parts = name.split('/').filter(Boolean);
    // "output.json" (single file archive) or "output/<file>" (directory archive).
    const fileName = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[1] : undefined;
    if (type !== 'file' || !fileName) {
      entry.resume();
      continue;
    }
    total += size;
    if (files.length + 1 > limits.maxFiles || total > limits.maxTotalBytes) {
      entry.resume();
      archive.destroy();
      throw new OutputLimitError(
        `container output exceeds limits (max ${limits.maxFiles} files, ${limits.maxTotalBytes} bytes)`,
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of entry) chunks.push(chunk as Buffer);
    files.push({ name: fileName, data: Buffer.concat(chunks) });
  }
  return files;
}

/**
 * Splits Docker's multiplexed log stream (non-TTY containers) into stdout/stderr.
 * Each frame is an 8-byte header — [stream, 0, 0, 0, size (uint32 BE)] — then payload.
 */
export function demuxDockerLogs(buffer: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    const payload = buffer.subarray(offset + 8, offset + 8 + size);
    (streamType === 2 ? err : out).push(payload);
    offset += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

/** Keeps the tail of long logs — the end is usually where the error is. */
export function truncateLog(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[… ${text.length - maxChars} earlier characters truncated …]\n${text.slice(-maxChars)}`;
}
