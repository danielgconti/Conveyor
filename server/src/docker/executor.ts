import type { Readable } from 'node:stream';
import type Docker from 'dockerode';
import type { Logger } from '../logger.js';
import { buildJobArchive, demuxDockerLogs, extractFiles, OutputLimitError, truncateLog, type NamedFile } from './archive.js';

export const MANAGED_LABEL = 'conveyor.managed';
export const JOB_ID_LABEL = 'conveyor.job-id';

const MAX_LOG_CHARS = 64 * 1024;
const MAX_OUTPUT_JSON_BYTES = 1024 * 1024;
const MAX_OUTPUT_FILES = 20;
const MAX_OUTPUT_FILES_BYTES = 50 * 1024 * 1024;

export interface ExecutionRequest {
  jobId: string;
  image: string;
  input: unknown;
  inputFiles: NamedFile[];
  cpu: number;
  memoryMb: number;
  timeoutSeconds: number;
  /** Aborting kills the container (used for cancellation and lost ownership). */
  signal: AbortSignal;
  /** Overrides the image's CMD. Not exposed through the API; used by tests. */
  command?: string[];
}

export type ExecutionResult =
  | {
      status: 'succeeded';
      exitCode: 0;
      output: unknown;
      outputFiles: NamedFile[];
      stdout: string;
      stderr: string;
    }
  | {
      status: 'failed' | 'timed_out' | 'cancelled';
      error: string;
      /** Whether running the same job again could plausibly succeed. */
      retryable: boolean;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    };

export interface DockerExecutorOptions {
  workerId: string;
  networkMode: string;
  /** "uid:gid" for the job process; empty string keeps the image's USER. */
  user: string;
  pidsLimit: number;
  pullMissingImages: boolean;
}

type StopReason = 'exited' | 'timed_out' | 'cancelled';

/**
 * Runs one job in one throwaway container. The container contract:
 *   - reads its input from /job/input.json (and /job/input/* files)
 *   - writes its result to /job/output.json (and optionally files to /job/output/)
 *   - exits 0 on success
 *
 * Inputs and outputs move through Docker's archive API (copy into the container
 * before start, copy out after exit) rather than a bind mount, so no host
 * directory is ever exposed to the job — and it works the same whether the
 * worker runs on the host or inside a container talking to the host's daemon.
 */
export class DockerExecutor {
  constructor(
    private readonly docker: Docker,
    private readonly options: DockerExecutorOptions,
    private readonly logger: Logger,
  ) {}

  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    const log = this.logger.child({ jobId: req.jobId, image: req.image });
    const fail = (
      error: string,
      retryable: boolean,
      ran: { exitCode: number | null; stdout: string; stderr: string } = { exitCode: null, stdout: '', stderr: '' },
    ): ExecutionResult => ({ status: 'failed', error, retryable, ...ran });

    const imageError = await this.ensureImage(req.image);
    if (imageError) return fail(imageError, false);

    let container: Docker.Container | undefined;
    try {
      container = await this.docker.createContainer({
        Image: req.image,
        Cmd: req.command,
        Env: [`CONVEYOR_JOB_ID=${req.jobId}`],
        User: this.options.user || undefined,
        Labels: {
          [MANAGED_LABEL]: 'true',
          [JOB_ID_LABEL]: req.jobId,
          'conveyor.worker-id': this.options.workerId,
        },
        NetworkDisabled: this.options.networkMode === 'none',
        HostConfig: {
          NanoCpus: Math.round(req.cpu * 1e9),
          Memory: req.memoryMb * 1024 * 1024,
          MemorySwap: req.memoryMb * 1024 * 1024, // equal to Memory = no swap
          PidsLimit: this.options.pidsLimit,
          NetworkMode: this.options.networkMode,
          Privileged: false,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
        },
      });
      log.info({ containerId: container.id }, 'container created');

      await container.putArchive(await buildJobArchive(req.input, req.inputFiles), { path: '/' });

      const { reason, exitCode } = await this.runToCompletion(container, req);
      const state = (await container.inspect()).State;
      const logs = demuxDockerLogs(
        (await container.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer,
      );
      const stdout = truncateLog(logs.stdout, MAX_LOG_CHARS);
      const stderr = truncateLog(logs.stderr, MAX_LOG_CHARS);
      const base = { exitCode, stdout, stderr };
      log.info({ reason, exitCode, oomKilled: state.OOMKilled }, 'container stopped');

      if (reason === 'timed_out') {
        return { status: 'timed_out', error: `Timed out after ${req.timeoutSeconds}s`, retryable: true, ...base };
      }
      if (reason === 'cancelled') {
        return { status: 'cancelled', error: 'Cancelled while running', retryable: false, ...base };
      }
      if (state.OOMKilled) {
        // The same limit will almost certainly be hit again.
        return fail(`Out of memory: exceeded the ${req.memoryMb}MB limit`, false, base);
      }
      if (exitCode !== 0) {
        return fail(`Container exited with code ${exitCode}`, true, base);
      }

      const output = await this.readOutputJson(container);
      if (output.error) return fail(output.error, false, base);
      const outputFiles = await this.readOutputFiles(container);
      if ('error' in outputFiles) return fail(outputFiles.error, false, base);

      return { status: 'succeeded', exitCode: 0, output: output.value, outputFiles: outputFiles.files, stdout, stderr };
    } catch (err) {
      log.error({ err }, 'docker execution error');
      return fail(`Docker error: ${(err as Error).message}`, true);
    } finally {
      await container?.remove({ force: true }).catch((err: unknown) => {
        log.warn({ err }, 'failed to remove container');
      });
    }
  }

  private async runToCompletion(
    container: Docker.Container,
    req: ExecutionRequest,
  ): Promise<{ reason: StopReason; exitCode: number | null }> {
    if (req.signal.aborted) return { reason: 'cancelled', exitCode: null };

    let reason: StopReason = 'exited';
    const stop = (why: StopReason) => {
      if (reason !== 'exited') return;
      reason = why;
      container.kill().catch(() => {
        /* already exited */
      });
    };
    const timer = setTimeout(() => stop('timed_out'), req.timeoutSeconds * 1000);
    const onAbort = () => stop('cancelled');
    req.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await container.start();
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      return { reason, exitCode: StatusCode };
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Returns an error message if the image can't be used, otherwise null. */
  private async ensureImage(image: string): Promise<string | null> {
    try {
      await this.docker.getImage(image).inspect();
      return null;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
    if (!this.options.pullMissingImages) {
      return `Image "${image}" not found on the worker (pulling is disabled; set PULL_MISSING_IMAGES=true or build the image first)`;
    }
    try {
      const stream = await this.docker.pull(image);
      await new Promise((resolve, reject) =>
        this.docker.modem.followProgress(stream, (err, res) => (err ? reject(err) : resolve(res))),
      );
      return null;
    } catch (err) {
      return `Failed to pull image "${image}": ${(err as Error).message}`;
    }
  }

  private async readOutputJson(container: Docker.Container): Promise<{ value: unknown; error?: string }> {
    const files = await this.readArchive(container, '/job/output.json', 1, MAX_OUTPUT_JSON_BYTES);
    if ('error' in files) return { value: null, error: files.error };
    const file = files.files[0];
    // No output.json is allowed: some workloads only produce logs or files.
    if (!file) return { value: null };
    try {
      return { value: JSON.parse(file.data.toString('utf8')) };
    } catch {
      return { value: null, error: '/job/output.json is not valid JSON' };
    }
  }

  private readOutputFiles(container: Docker.Container) {
    return this.readArchive(container, '/job/output', MAX_OUTPUT_FILES, MAX_OUTPUT_FILES_BYTES);
  }

  private async readArchive(
    container: Docker.Container,
    path: string,
    maxFiles: number,
    maxTotalBytes: number,
  ): Promise<{ files: NamedFile[] } | { error: string }> {
    let archive: NodeJS.ReadableStream;
    try {
      archive = await container.getArchive({ path });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return { files: [] };
      throw err;
    }
    try {
      return { files: await extractFiles(archive as Readable, { maxFiles, maxTotalBytes }) };
    } catch (err) {
      if (err instanceof OutputLimitError) return { error: err.message };
      throw err;
    }
  }
}
