import { Readable } from 'node:stream';
import tar from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { buildJobArchive, demuxDockerLogs, extractFiles, OutputLimitError, truncateLog } from '../src/docker/archive.js';

async function listArchive(buffer: Buffer) {
  const extract = tar.extract();
  Readable.from(buffer).pipe(extract);
  const entries: { name: string; type: string; mode?: number; body: string }[] = [];
  for await (const entry of extract) {
    const chunks: Buffer[] = [];
    for await (const c of entry) chunks.push(c as Buffer);
    entries.push({ name: entry.header.name, type: entry.header.type!, mode: entry.header.mode, body: Buffer.concat(chunks).toString() });
  }
  return entries;
}

async function makeTar(files: Record<string, string>): Promise<Readable> {
  const pack = tar.pack();
  for (const [name, body] of Object.entries(files)) {
    if (name.endsWith('/')) pack.entry({ name, type: 'directory' });
    else pack.entry({ name }, body);
  }
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  return Readable.from(Buffer.concat(chunks));
}

describe('buildJobArchive', () => {
  it('lays out /job with input.json, input files and a writable output dir', async () => {
    const entries = await listArchive(await buildJobArchive({ text: 'hi' }, [{ name: 'a.txt', data: Buffer.from('A') }]));
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

    expect(JSON.parse(byName['job/input.json']!.body)).toEqual({ text: 'hi' });
    expect(byName['job/input/a.txt']!.body).toBe('A');
    expect(byName['job/output']!.type).toBe('directory');
    expect(byName['job/output']!.mode).toBe(0o777);
  });
});

describe('extractFiles', () => {
  it('returns top-level files from a directory archive', async () => {
    const files = await extractFiles(
      await makeTar({ 'output/': '', 'output/result.png': 'PNG', 'output/nested/deep.txt': 'x' }),
      { maxFiles: 10, maxTotalBytes: 1000 },
    );
    expect(files.map((f) => [f.name, f.data.toString()])).toEqual([['result.png', 'PNG']]);
  });

  it('returns the file from a single-file archive', async () => {
    const files = await extractFiles(await makeTar({ 'output.json': '{}' }), { maxFiles: 1, maxTotalBytes: 100 });
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('output.json');
  });

  it('enforces limits', async () => {
    await expect(
      extractFiles(await makeTar({ 'output/a': 'x'.repeat(50), 'output/b': 'y'.repeat(60) }), {
        maxFiles: 10,
        maxTotalBytes: 100,
      }),
    ).rejects.toBeInstanceOf(OutputLimitError);
    await expect(
      extractFiles(await makeTar({ 'output/a': '1', 'output/b': '2' }), { maxFiles: 1, maxTotalBytes: 100 }),
    ).rejects.toBeInstanceOf(OutputLimitError);
  });
});

describe('demuxDockerLogs', () => {
  const frame = (stream: number, text: string) => {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  it('splits stdout and stderr frames', () => {
    const logs = demuxDockerLogs(Buffer.concat([frame(1, 'out1\n'), frame(2, 'err\n'), frame(1, 'out2\n')]));
    expect(logs).toEqual({ stdout: 'out1\nout2\n', stderr: 'err\n' });
  });
});

describe('truncateLog', () => {
  it('keeps the tail', () => {
    expect(truncateLog('short', 10)).toBe('short');
    expect(truncateLog('0123456789abcdef', 6)).toMatch(/abcdef$/);
  });
});
