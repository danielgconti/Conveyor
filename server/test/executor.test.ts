import { beforeAll, describe, expect, it } from 'vitest';
import { DockerExecutor, MANAGED_LABEL, type ExecutionRequest } from '../src/docker/executor.js';
import { docker, dockerAvailable, silentLogger } from './helpers.js';

// Integration tests: these start real containers on the local Docker daemon.
const IMAGE = 'alpine:3.20';
const hasDocker = await dockerAvailable();

describe.skipIf(!hasDocker)('DockerExecutor (requires Docker)', () => {
  const executor = new DockerExecutor(
    docker,
    { workerId: 'test-worker', networkMode: 'none', user: '65534:65534', pidsLimit: 64, pullMissingImages: false },
    silentLogger,
  );

  const run = (script: string, overrides: Partial<ExecutionRequest> = {}) =>
    executor.run({
      jobId: crypto.randomUUID(),
      image: IMAGE,
      input: { text: 'hello world' },
      inputFiles: [],
      cpu: 0.5,
      memoryMb: 64,
      timeoutSeconds: 20,
      signal: new AbortController().signal,
      command: ['sh', '-c', script],
      ...overrides,
    });

  beforeAll(async () => {
    try {
      await docker.getImage(IMAGE).inspect();
    } catch {
      const stream = await docker.pull(IMAGE);
      await new Promise((resolve, reject) =>
        docker.modem.followProgress(stream, (err, res) => (err ? reject(err) : resolve(res))),
      );
    }
  });

  it('passes input in and reads output.json, output files and logs back', async () => {
    const result = await run(
      `echo starting; echo warn >&2;
       tr a-z A-Z < /job/input/note.txt > /job/output/shout.txt;
       echo "{\\"input\\": $(cat /job/input.json | tr -d '\\n')}" > /job/output.json`,
      { inputFiles: [{ name: 'note.txt', data: Buffer.from('quiet') }] },
    );

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.output).toEqual({ input: { text: 'hello world' } });
    expect(result.outputFiles.map((f) => [f.name, f.data.toString()])).toEqual([['shout.txt', 'QUIET']]);
    expect(result.stdout).toBe('starting\n');
    expect(result.stderr).toBe('warn\n');
  });

  it('succeeds with null output when the container writes no output.json', async () => {
    const result = await run('echo only logs');
    expect(result).toMatchObject({ status: 'succeeded', output: null, outputFiles: [] });
  });

  it('runs as an unprivileged user with no network', async () => {
    const result = await run('id -u > /tmp/u; (wget -q -T 2 -O- http://1.1.1.1 && echo net) || echo nonet; cat /tmp/u');
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.stdout).toContain('nonet\n65534');
  });

  it('reports a non-zero exit as a retryable failure', async () => {
    const result = await run('echo boom >&2; exit 3');
    expect(result).toMatchObject({ status: 'failed', exitCode: 3, retryable: true, stderr: 'boom\n' });
  });

  it('reports invalid output.json as a non-retryable failure', async () => {
    const result = await run('echo "not json" > /job/output.json');
    expect(result).toMatchObject({ status: 'failed', retryable: false, error: '/job/output.json is not valid JSON' });
  });

  it('kills the container when the timeout elapses', async () => {
    const started = Date.now();
    const result = await run('sleep 30', { timeoutSeconds: 1 });
    expect(result.status).toBe('timed_out');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('kills the container when the signal is aborted', async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 1000);
    const result = await run('sleep 30', { signal: abort.signal });
    expect(result.status).toBe('cancelled');
  });

  it('detects out-of-memory kills', async () => {
    // Allocate far more than the 16MB limit inside the shell process itself.
    const result = await run('x=$(head -c 200000000 /dev/zero | tr "\\0" a); echo done', { memoryMb: 16 });
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    if (result.status === 'failed') expect(result.error).toMatch(/Out of memory/);
  });

  it('fails without retry when the image does not exist', async () => {
    const result = await run('true', { image: 'conveyor/does-not-exist:never' });
    expect(result).toMatchObject({ status: 'failed', retryable: false });
  });

  it('removes containers after every run', async () => {
    await run('true');
    const leftovers = await docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=true`] } });
    expect(leftovers.filter((c) => c.Labels['conveyor.worker-id'] === 'test-worker')).toEqual([]);
  });
});
