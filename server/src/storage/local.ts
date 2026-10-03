import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ArtifactStore } from './index.js';

/** Stores artifacts on a directory shared by the API and worker (a Docker volume in Compose). */
export class LocalArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`invalid artifact key: ${key}`);
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async stream(key: string): Promise<Readable> {
    const stream = createReadStream(this.resolve(key));
    // Surface ENOENT here rather than mid-response.
    await new Promise<void>((resolve, reject) => stream.once('open', () => resolve()).once('error', reject));
    return stream;
  }
}
