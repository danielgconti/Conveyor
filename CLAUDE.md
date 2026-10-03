# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Conveyor: an asynchronous job execution platform. Users submit a Docker image plus a JSON input; a worker runs it in a throwaway, resource-limited container and stores output/logs. The platform never knows what a container does. `examples/` holds demo workloads (Python) and is **not** part of the platform.

## Commands

All backend commands run from `server/`; frontend from `web/`.

```bash
docker compose build && docker compose up        # whole system; dashboard at http://localhost:8080
docker compose up -d postgres redis              # infra only, for running app code on the host

# server/
npm run dev:api | npm run dev:worker             # tsx watch; loads server/.env (copy .env.example)
npm run typecheck
npm test                                         # vitest; Docker tests auto-skip if no daemon
TEST_DATABASE_URL='postgresql://conveyor:conveyor@localhost:5432/conveyor?schema=test' npm test  # + DB tests
npx vitest run test/executor.test.ts             # single file
npx vitest run -t 'kills the container'          # single test by name
npx prisma migrate dev --name <change>           # after editing prisma/schema.prisma

# web/
npm run dev        # :5173, proxies /api to :3000
npm run build      # tsc -b && vite build
```

DB tests (`api.test.ts`, `processor.test.ts`) skip unless `TEST_DATABASE_URL` is set; `test/global-setup.ts` migrates that schema once, and files run serially (`fileParallelism: false`) because they share tables.

## Architecture

`server/` is one TypeScript (ESM, NodeNext — relative imports need `.js`) codebase with two entrypoints sharing all modules: `src/api/main.ts` (Fastify) and `src/worker/main.ts`. Same Docker image; compose overrides the command for the worker. The API container runs `prisma migrate deploy` on start; the worker waits for the API to be healthy.

**Postgres is the source of truth; the queue carries only job ids.** Every state transition is a guarded `updateMany` (`WHERE id AND status = …`, plus `workerId` when the worker finalizes). This is what makes at-least-once delivery, cancellation and crash recovery safe — preserve it when adding transitions:

- Claim: `QUEUED → RUNNING` only if still `QUEUED` (`worker/processor.ts`). Losing the claim = drop the message.
- Heartbeat every `HEARTBEAT_INTERVAL_MS`; if the guarded heartbeat updates 0 rows (job cancelled or reaped), the worker aborts → executor kills the container. Cancellation works only through this path; the API never talks to Docker.
- `worker/transitions.ts#failOrRetry` is the single place that decides retry (back to `QUEUED`, `retryCount+1`, re-enqueue with backoff) vs terminal `FAILED`/`TIMED_OUT`. Used by both the processor and the reaper.
- `worker/reaper.ts` runs on every worker: fails/requeues `RUNNING` jobs with stale heartbeats, and removes containers labelled `conveyor.managed` whose job isn't `RUNNING`.
- Retries are owned by the platform, not BullMQ (`attempts: 1`), so behaviour is identical on SQS.

**Executor (`src/docker/executor.ts`)** — the only code that talks to Docker. Container contract: `/job/input.json` + `/job/input/*` in, `/job/output.json` + `/job/output/*` out, exit 0 = success. I/O is copied via Docker's archive API (`putArchive` before start, `getArchive` after exit) — **never bind mounts**, because the worker runs in a container talking to the host daemon (host paths wouldn't match) and to avoid exposing host directories. Retryability is decided here: non-zero exit / timeout / Docker errors are retryable; missing image, OOM, invalid output.json, output over limits are not.

**Swappable backends** behind small interfaces chosen by env: `queue/` (`JobQueue`: BullMQ | SQS via `QUEUE_DRIVER`) and `storage/` (`ArtifactStore`: local dir | S3 via `STORAGE_DRIVER`). Artifact keys: `jobs/<id>/{input,output}/<name>`; the API serves only names recorded in `job.inputFiles`/`outputFiles`.

**Config** is zod-validated env in `src/config.ts` (all defaults/limits live there). Request validation is `src/domain/job-request.ts` (built from `JobLimits`, `.strict()` — unknown fields rejected). `src/domain/` is pure and unit-tested.

`web/` is React 19 + Vite + TanStack Query + react-router, plain CSS (`src/styles.css`, light/dark via CSS variables). `src/types.ts` mirrors `server/src/api/serialize.ts` — keep them in sync. Polling via `refetchInterval` (job detail stops polling at terminal states). In compose, nginx serves the build and proxies `/api` to the API.

## Conventions and constraints

- Prisma is pinned to 6.19.x (classic `prisma-client-js` generator); don't upgrade to 7 casually.
- Security defaults for job containers (non-root `65534:65534`, `NetworkMode none`, `CapDrop ALL`, `no-new-privileges`, no swap, PID limit) are deliberate; don't loosen them to make an example work — fix the example (e.g. bake models into the image, make dirs readable by any user).
- The worker mounts the host Docker socket in compose; README "Security" documents why this is dev-only. Don't claim production-safety for untrusted users.
- AWS target architecture and rollout: `docs/aws-deployment.md` (workers must be EC2, not Fargate, because they need a Docker daemon).
