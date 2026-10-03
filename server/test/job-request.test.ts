import { describe, expect, it } from 'vitest';
import { createJobRequestSchema, parseMemoryMb } from '../src/domain/job-request.js';
import { testLimits } from './helpers.js';

describe('parseMemoryMb', () => {
  it.each([
    ['512m', 512],
    ['512M', 512],
    ['512mb', 512],
    ['2g', 2048],
    ['256', 256],
    [1024, 1024],
  ])('parses %s', (input, expected) => {
    expect(parseMemoryMb(input)).toBe(expected);
  });

  it.each(['', 'lots', '1.5g', '-1m', '0m', 0, 1.5])('rejects %s', (input) => {
    expect(parseMemoryMb(input)).toBeNull();
  });
});

describe('createJobRequestSchema', () => {
  const schema = createJobRequestSchema(testLimits);

  it('applies defaults', () => {
    expect(schema.parse({ image: 'conveyor/cpu-worker:latest' })).toEqual({
      image: 'conveyor/cpu-worker:latest',
      input: {},
      inputFiles: {},
      resources: { cpu: 1, memory: 512, timeout: 60 },
      maxRetries: 0,
    });
  });

  it('accepts explicit resources with memory strings', () => {
    const req = schema.parse({
      image: 'worker',
      input: { text: 'hi' },
      resources: { cpu: 0.5, memory: '1g', timeout: 10 },
      maxRetries: 2,
    });
    expect(req.resources).toEqual({ cpu: 0.5, memory: 1024, timeout: 10 });
    expect(req.maxRetries).toBe(2);
  });

  it.each([
    ['missing image', {}],
    ['invalid image reference', { image: 'Not An Image!' }],
    ['non-object input', { image: 'w', input: [1, 2] }],
    ['cpu over max', { image: 'w', resources: { cpu: 64 } }],
    ['memory over max', { image: 'w', resources: { memory: '64g' } }],
    ['unparseable memory', { image: 'w', resources: { memory: 'lots' } }],
    ['timeout over max', { image: 'w', resources: { timeout: 99999 } }],
    ['too many retries', { image: 'w', maxRetries: 50 }],
    ['path traversal in file name', { image: 'w', inputFiles: { '../etc/passwd': 'aGk=' } }],
    ['non-base64 file contents', { image: 'w', inputFiles: { 'a.txt': 'not base64!' } }],
    ['files over size limit', { image: 'w', inputFiles: { 'a.bin': Buffer.alloc(2048).toString('base64') } }],
    ['unknown field', { image: 'w', command: ['rm', '-rf', '/'] }],
  ])('rejects %s', (_name, body) => {
    expect(schema.safeParse(body).success).toBe(false);
  });

  it('enforces the image allowlist when configured', () => {
    const restricted = createJobRequestSchema({ ...testLimits, allowedImagePrefixes: ['conveyor/'] });
    expect(restricted.safeParse({ image: 'conveyor/cpu-worker' }).success).toBe(true);
    expect(restricted.safeParse({ image: 'evil/miner' }).success).toBe(false);
  });
});
