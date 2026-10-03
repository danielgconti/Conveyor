import { jobLimitsFromConfig, loadConfig } from '../config.js';
import { createPrisma } from '../db.js';
import { createLogger } from '../logger.js';
import { createJobQueue } from '../queue/index.js';
import { createArtifactStore } from '../storage/index.js';
import { buildApp } from './app.js';

const config = loadConfig();
const logger = createLogger('api', config.LOG_LEVEL);
const prisma = createPrisma();
const queue = createJobQueue(config, logger);

const app = buildApp(
  { prisma, queue, artifacts: createArtifactStore(config), logger },
  jobLimitsFromConfig(config),
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
