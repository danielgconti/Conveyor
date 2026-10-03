import Docker from 'dockerode';
import { loadConfig } from '../config.js';
import { createPrisma } from '../db.js';
import { DockerExecutor } from '../docker/executor.js';
import { createLogger } from '../logger.js';
import { createJobQueue } from '../queue/index.js';
import { createArtifactStore } from '../storage/index.js';
import { processJob, type ProcessorDeps } from './processor.js';
import { reapStaleJobs, removeOrphanedContainers } from './reaper.js';

const config = loadConfig();
const logger = createLogger('worker', config.LOG_LEVEL).child({ workerId: config.WORKER_ID });

const docker = new Docker({ socketPath: config.DOCKER_SOCKET });
try {
  await docker.ping();
} catch (err) {
  logger.fatal({ err, socket: config.DOCKER_SOCKET }, 'cannot reach the Docker daemon');
  process.exit(1);
}

const prisma = createPrisma();
const queue = createJobQueue(config, logger);
const deps: ProcessorDeps = {
  prisma,
  queue,
  logger,
  retryBaseDelayMs: config.RETRY_BASE_DELAY_MS,
  artifacts: createArtifactStore(config),
  workerId: config.WORKER_ID,
  heartbeatIntervalMs: config.HEARTBEAT_INTERVAL_MS,
  executor: new DockerExecutor(
    docker,
    {
      workerId: config.WORKER_ID,
      networkMode: config.JOB_NETWORK_MODE,
      user: config.JOB_CONTAINER_USER,
      pidsLimit: config.JOB_PIDS_LIMIT,
      pullMissingImages: config.PULL_MISSING_IMAGES,
    },
    logger,
  ),
};

async function maintenance(): Promise<void> {
  try {
    const reaped = await reapStaleJobs(deps, config.STALE_JOB_THRESHOLD_MS);
    if (reaped > 0) logger.warn({ reaped }, 'recovered stale RUNNING jobs');
    await removeOrphanedContainers(deps, docker);
  } catch (err) {
    logger.error({ err }, 'maintenance pass failed');
  }
}

await maintenance();
const maintenanceTimer = setInterval(maintenance, config.REAPER_INTERVAL_MS);

queue.consume((jobId) => processJob(jobId, deps), { concurrency: config.WORKER_CONCURRENCY });
logger.info({ concurrency: config.WORKER_CONCURRENCY, queue: config.QUEUE_DRIVER }, 'worker started');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down: finishing in-flight jobs');
  clearInterval(maintenanceTimer);
  await queue.close();
  await prisma.$disconnect();
  logger.info('worker stopped');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
