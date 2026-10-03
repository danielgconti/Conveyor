import { PrismaClient } from '@prisma/client';

export type { Job, JobStatus } from '@prisma/client';
export { Prisma, PrismaClient } from '@prisma/client';

export function createPrisma(): PrismaClient {
  return new PrismaClient();
}
