import type { Readable } from 'node:stream';
import type { Config } from '../config.js';
import { LocalArtifactStore } from './local.js';
import { S3ArtifactStore } from './s3.js';

/** Blob storage for job input/output files. Keys look like "jobs/<id>/output/<name>". */
export interface ArtifactStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
}

export const artifactKey = (jobId: string, kind: 'input' | 'output', name: string) =>
  `jobs/${jobId}/${kind}/${name}`;

export function createArtifactStore(config: Config): ArtifactStore {
  switch (config.STORAGE_DRIVER) {
    case 'local':
      return new LocalArtifactStore(config.ARTIFACTS_DIR);
    case 's3':
      return new S3ArtifactStore(config.S3_BUCKET!, config.AWS_REGION);
  }
}
