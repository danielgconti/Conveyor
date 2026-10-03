# Conveyor

**A container-based asynchronous job execution platform.** Submit any Docker image together with an input payload. Conveyor queues the job, runs the image in an isolated, resource-limited container on a worker, and stores the output, logs and exit status so you can collect them later.

```
USER → API → JOB QUEUE → WORKER → DOCKER CONTAINER → RESULT
```

Conveyor knows nothing about what a container does. An LLM inference image, an image resizer and a data-processing script are all the same to it: an image, an input and a set of resource limits. The engineering is in the execution infrastructure: an asynchronous API, a durable job lifecycle, at-least-once queue delivery with idempotent claims, retries with backoff, timeouts, cancellation, crash recovery and container cleanup.

> **Security note:** Conveyor runs arbitrary containers. The local setup gives the worker access to the host's Docker daemon. That is fine for local development and **not safe for untrusted users**. See [Security](#security).

---

## Contents

1. [Why asynchronous job execution](#why-asynchronous-job-execution)
2. [Architecture](#architecture)
3. [How a job flows through the system](#how-a-job-flows-through-the-system)
4. [Docker images and containers](#docker-images-and-containers)
5. [The container contract (input/output)](#the-container-contract)
6. [Job lifecycle](#job-lifecycle)
7. [API](#api)
8. [Quick start](#quick-start)
9. [Local development](#local-development)
10. [Example workloads](#example-workloads)
11. [Reliability](#reliability)
12. [Security](#security)
13. [AWS deployment](#aws-deployment)
14. [Project layout](#project-layout)
15. [Future improvements](#future-improvements)

---

## Why asynchronous job execution

Some work doesn't fit inside an HTTP request: video transcoding, model inference, report generation, batch data processing. If the API ran that work inline:

- **Requests would hang or time out.** Load balancers and browsers typically give up after 30–60 seconds.
- **Load spikes would overwhelm the API.** Every slow request holds a connection and memory on the API server.
- **Failures would be lost.** If the server restarted mid-request, the work would simply vanish.
- **The API and the compute couldn't scale separately.** You'd have to over-provision the API to handle peak compute.

Instead, `POST /api/jobs` validates the request, records the job, puts its id on a queue and returns **`202 Accepted`** in milliseconds. Workers pull from the queue at their own pace, and clients poll for the result. The API stays fast and stateless. The queue absorbs bursts. Workers scale independently, and because job state lives in a database, a crash on either side is recoverable.

## Architecture

```mermaid
flowchart LR
    U([User / Dashboard]) -->|HTTP| W[web<br/>nginx + React]
    W -->|/api| A[API<br/>Fastify]
    A -->|job rows| P[(PostgreSQL<br/>source of truth)]
    A -->|job id| Q[[Queue<br/>BullMQ/Redis · SQS]]
    A -->|input files| S[(Artifact store<br/>volume · S3)]
    Q -->|job id| K[Worker]
    K <-->|claim · heartbeat · result| P
    K <-->|input / output files| S
    K -->|Docker API| D{{Docker daemon}}
    D --> C1[job container]
    D --> C2[job container]
```

| Component | Responsibility | Local | AWS |
|---|---|---|---|
| **web** | Dashboard UI; proxies `/api` to the API | nginx container | S3 + CloudFront, or nginx behind the ALB |
| **API** (`server/src/api`) | Validate, create, list, cancel jobs; serve results | Node container | ECS service behind an ALB |
| **Queue** (`server/src/queue`) | Deliver job ids to workers | Redis + BullMQ | SQS |
| **Database** | Job metadata and state machine | PostgreSQL container | RDS PostgreSQL |
| **Artifact store** (`server/src/storage`) | Input and output files | Shared Docker volume | S3 |
| **Worker** (`server/src/worker`) | Claim jobs, run containers, record results | Node container + host Docker socket | EC2 instances (ECS on EC2) |
| **Executor** (`server/src/docker`) | One job → one throwaway, locked-down container | Docker Engine API | Same |

The API and the worker are two entrypoints into one TypeScript codebase. They share the domain model, the queue and storage interfaces, and the Prisma schema. The queue and storage are behind small interfaces, so switching from local to AWS is a configuration change (`QUEUE_DRIVER=sqs`, `STORAGE_DRIVER=s3`), not a code change.

**Design principle: Postgres is the source of truth, and the queue only carries job ids.** That one decision makes the rest simple. Queue messages can be delivered twice, delayed or lost without corrupting state, because every state change is a conditional update in the database.

## How a job flows through the system

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API
    participant DB as Postgres
    participant Q as Queue
    participant W as Worker
    participant D as Docker

    C->>A: POST /api/jobs {image, input, resources}
    A->>A: validate (zod)
    A->>DB: INSERT job (QUEUED)
    A->>Q: enqueue(jobId)
    A-->>C: 202 {jobId, status: QUEUED}
    Q->>W: deliver jobId
    W->>DB: UPDATE … SET RUNNING WHERE status = QUEUED  (atomic claim)
    W->>D: create container (limits, no network, non-root)
    W->>D: copy /job/input.json + /job/input/* into container
    W->>D: start, wait (timeout timer + cancellation signal)
    loop every 5s while running
        W->>DB: heartbeat WHERE status = RUNNING AND workerId = me
    end
    D-->>W: exit code
    W->>D: read logs, copy out /job/output.json + /job/output/*
    W->>D: remove container
    W->>DB: SUCCEEDED + output  /  QUEUED (retry)  /  FAILED · TIMED_OUT
    C->>A: GET /api/jobs/:id (polling)
    A-->>C: status, output, logs
```

## Docker images and containers

An **image** is a packaged, immutable filesystem plus a default command, e.g. `conveyor/cpu-worker:latest` = Python 3.12 + `main.py` + `CMD ["python", "main.py"]`. A **container** is one running instance of an image, with its own process space, filesystem layer, network namespace and resource limits.

Conveyor creates **one fresh container per job attempt** and removes it afterwards. Every job starts from a clean filesystem, one job's leftovers can't affect the next, and limits apply per job. The worker drives Docker through the Docker Engine API (via [`dockerode`](https://github.com/apocas/dockerode)). On each container it:

| Setting | Value | Why |
|---|---|---|
| `NanoCpus` | `cpu × 10⁹` | CPU limit (e.g. `0.5` = half a core) |
| `Memory` / `MemorySwap` | `memoryMb` (equal) | Hard memory cap with no swap; exceeding it gets the process OOM-killed |
| `PidsLimit` | 256 | Stops fork bombs |
| `NetworkMode` | `none` | No network access by default |
| `User` | `65534:65534` (nobody) | Never root inside the container |
| `CapDrop` | `ALL` | No Linux capabilities |
| `SecurityOpt` | `no-new-privileges` | Blocks setuid privilege escalation |
| `Privileged` | `false` | Always |
| Labels | `conveyor.managed`, `conveyor.job-id` | Lets the worker find and clean up orphaned containers |

## The container contract

Any image can run on Conveyor if it follows this contract:

| Path | Direction | Contents |
|---|---|---|
| `/job/input.json` | in | The job's `input` object, verbatim |
| `/job/input/<name>` | in | Files attached to the job (`inputFiles`) |
| `/job/output.json` | out | The result. Must be valid JSON. Optional. |
| `/job/output/<name>` | out | Result files (images, CSVs, …). Optional. |
| exit code | out | `0` = success. Anything else = failure (retryable). |
| stdout / stderr | out | Captured (last 64 KB each) and shown on the job page |

A minimal worker in any language:

```python
import json
data = json.load(open("/job/input.json"))
json.dump({"result": data["text"].upper()}, open("/job/output.json", "w"))
```

**How files get in and out.** The worker does *not* bind-mount a host directory into job containers. It builds a tar archive in memory with `input.json` and any input files and copies it into the created container with Docker's archive API (`PUT /containers/{id}/archive`), *before* starting it. After the container exits, it copies `/job/output.json` and `/job/output/` back out the same way (`GET /containers/{id}/archive`), then removes the container. This means:

- **No host paths are ever exposed to a job.**
- The worker behaves the same whether it runs on the host or inside a container. A bind mount from a containerized worker would need host-side paths, a classic Docker-socket pitfall.
- Output is size-limited as it streams out: 1 MB for `output.json`, 20 files / 50 MB for `/job/output/`.

Input files are stored in the artifact store (`jobs/<id>/input/<name>`) when the job is created. Output files are written to `jobs/<id>/output/<name>`. The API serves both from `GET /api/jobs/:id/files/{input|output}/:name`.

## Job lifecycle

```mermaid
stateDiagram-v2
    [*] --> QUEUED: POST /api/jobs
    QUEUED --> RUNNING: worker claims job
    RUNNING --> SUCCEEDED: exit 0
    RUNNING --> QUEUED: retryable failure,<br/>retries left (backoff)
    RUNNING --> FAILED: non-retryable failure,<br/>or retries exhausted
    RUNNING --> TIMED_OUT: timeout,<br/>retries exhausted
    QUEUED --> CANCELLED: POST /cancel
    RUNNING --> CANCELLED: POST /cancel<br/>(container killed)
    SUCCEEDED --> [*]
    FAILED --> [*]
    TIMED_OUT --> [*]
    CANCELLED --> [*]
```

| Failure | Status | Retried? |
|---|---|---|
| Non-zero exit code | `FAILED` | ✅ |
| Exceeded `timeout` | `TIMED_OUT` | ✅ |
| Worker crashed / stopped heartbeating | `FAILED` | ✅ |
| Docker / internal error | `FAILED` | ✅ |
| Out of memory (OOM-killed) | `FAILED` | ❌ (the same limit would fail again) |
| Image not found | `FAILED` | ❌ |
| Invalid `/job/output.json`, or output over the size limits | `FAILED` | ❌ |

Retries back off exponentially (2 s, 4 s, 8 s … capped at 60 s). Each job records `createdAt`, `startedAt` (latest attempt), `completedAt`, `retryCount` and `maxRetries`.

## API

All endpoints are under `/api`. Errors return `{ "error": string, "issues"?: [{ path, message }] }`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/jobs` | Create a job. Returns **202** `{ jobId, status }` and a `Location` header. |
| `GET` | `/api/jobs?status=&limit=&offset=` | List jobs, newest first: `{ jobs, total }` |
| `GET` | `/api/jobs/stats` | Counts per status, plus `TOTAL` |
| `GET` | `/api/jobs/:id` | Full job: status, input, output, error, logs, limits, timestamps |
| `POST` | `/api/jobs/:id/cancel` | Cancel a `QUEUED` or `RUNNING` job (409 if already finished) |
| `GET` | `/api/jobs/:id/files/:kind/:name` | Download an input or output file |
| `GET` | `/healthz` | Liveness and database check |

**Create a job:**

```bash
curl -X POST localhost:8080/api/jobs -H 'content-type: application/json' -d '{
  "image": "conveyor/cpu-worker:latest",
  "input": { "number": 1000000 },
  "resources": { "cpu": 1, "memory": "512m", "timeout": 60 },
  "maxRetries": 2
}'
# → 202 {"jobId":"5f0c…","status":"QUEUED"}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `image` | string | required | Any Docker image reference. Optionally restricted by `ALLOWED_IMAGE_PREFIXES`. |
| `input` | object | `{}` | Written to `/job/input.json` |
| `inputFiles` | `{ [name]: base64 }` | `{}` | Written to `/job/input/<name>`. 10 MB total by default. |
| `resources.cpu` | number | `1` | Cores, max `MAX_CPU` (4) |
| `resources.memory` | `"512m"`, `"1g"` or MB | `512m` | Max `MAX_MEMORY_MB` (4096) |
| `resources.timeout` | seconds | `60` | Max `MAX_TIMEOUT_SECONDS` (3600) |
| `maxRetries` | integer | `0` | Max `MAX_RETRIES_LIMIT` (5) |

## Quick start

Requirements: Docker with Compose v2.

```bash
docker compose build   # platform + example workload images
docker compose up
```

Then open **http://localhost:8080**.

1. Go to **Submit job**. The *Count primes* preset is already filled in. Click **Submit job**.
2. You're taken to the job page: **Queued → Running → Succeeded**, updating live.
3. The output, logs, timing and resource limits appear on the job page.

Try the other presets: *Resize image* (uploads a sample photo; shows the processed image), *Flaky job* (fails and retries twice), and *Slow job* (times out after 5 s). Cancel a slow job while it's running to watch the container get killed.

`docker compose build` also builds the example workload images (`conveyor/cpu-worker`, `conveyor/image-worker`). The ML example is about 2 GB, so it's opt-in:

```bash
docker compose --profile ml build example-sentiment
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:8080 |
| API (direct) | http://localhost:3000 |
| Postgres | `postgresql://conveyor:conveyor@localhost:5432/conveyor` |
| Redis | `redis://localhost:6379` |

## Local development

Run the infrastructure in Docker and the app on the host, with hot reload:

```bash
docker compose up -d postgres redis            # infrastructure only
docker compose build example-cpu example-image # example workload images

cd server
npm install
cp .env.example .env
npx prisma migrate deploy
npm run dev:api        # terminal 1, :3000
npm run dev:worker     # terminal 2, uses the host Docker socket

cd ../web
npm install
npm run dev            # terminal 3, :5173 (proxies /api to :3000)
```

**Tests** (`server/`, Vitest):

```bash
npm test                                   # unit tests; Docker tests run if Docker is up
TEST_DATABASE_URL='postgresql://conveyor:conveyor@localhost:5432/conveyor?schema=test' npm test   # + DB tests
npx vitest run test/executor.test.ts       # a single file
npx vitest run -t 'kills the container'    # a single test by name
```

| Suite | Covers | Needs |
|---|---|---|
| `job-request`, `lifecycle`, `archive` | Validation, retry policy, tar/log handling | nothing |
| `executor` | Real containers: I/O contract, non-root user, no network, exit codes, timeout, cancellation, OOM, cleanup | Docker |
| `api` | HTTP endpoints, 202 flow, validation errors, queue outage, cancel | Postgres |
| `processor` | Claim, retries with backoff, cancellation while running, stale-job reaping | Postgres |

**Schema changes:** edit `server/prisma/schema.prisma`, then `npx prisma migrate dev --name <change>`.

**Configuration** is environment-based and validated at startup. See [`server/src/config.ts`](server/src/config.ts) for every option (job limits, worker concurrency, heartbeat and reaper intervals, network mode, container user, image allowlist, queue and storage drivers).

## Example workloads

These live in [`examples/`](examples/). They demonstrate the platform; they aren't part of it. Each is a few dozen lines that follow the container contract.

| Image | What it does | Example input |
|---|---|---|
| `conveyor/cpu-worker` | Counts primes up to N (CPU-bound sieve). `sleepSeconds` and `exitCode` knobs demo timeouts and retries. | `{"number": 5000000}` |
| `conveyor/image-worker` | Pillow: `resize`, `thumbnail`, `grayscale`, `blur`, `rotate`. Writes `/job/output/result.png`. | `{"imagePath": "/job/input/image.jpg", "operation": "resize", "width": 500, "height": 500}` + an image file |
| `conveyor/sentiment-worker` | Pretrained DistilBERT sentiment classifier. The model is baked into the image because jobs have no network. Needs about 1.5 GB of memory. | `{"texts": ["great!", "awful"]}` |

To run your own image, build it locally (`docker build -t my-worker .`) and submit `my-worker` as the image. The worker only runs images present on its Docker host unless `PULL_MISSING_IMAGES=true`.

## Reliability

| Concern | Mechanism |
|---|---|
| API must not block on work | `202 Accepted`. The API only writes a row and enqueues an id. |
| Duplicate / redelivered messages | Atomic claim: `UPDATE … SET status='RUNNING' WHERE id=? AND status='QUEUED'`. A losing claim drops the message. |
| Queue unavailable at submit | Job is marked `FAILED` ("Could not enqueue job") and the API returns 503. No job is left `QUEUED` with nothing to pick it up. |
| Worker crash mid-job | The worker heartbeats every 5 s. A **reaper** on every worker fails or re-queues `RUNNING` jobs with no heartbeat for 60 s. Jobs never stay `RUNNING` forever. |
| Cancellation | `POST /cancel` flips the row to `CANCELLED`. The owning worker's next heartbeat matches no rows, so it aborts and kills the container. |
| Stale writes | Every finalizing update is guarded by `status='RUNNING' AND workerId=me`, so a reaped or cancelled job is never overwritten by a slow worker. |
| Retries | Owned by the platform, not the queue, so behaviour is identical on BullMQ and SQS. Exponential backoff via delayed messages. |
| Leaked containers | Containers are removed in a `finally`. A periodic sweep removes any labelled container whose job isn't `RUNNING`, e.g. after a `kill -9`. |
| Runaway jobs | CPU, memory and PID limits, a timeout, and size limits on logs and output |
| Graceful shutdown | On `SIGTERM` the worker stops taking new jobs and finishes in-flight ones. If it's force-killed, the reaper recovers its jobs. |
| Worker or API failure isolation | Separate processes. The API never talks to Docker, and a worker failure becomes job state. |

## Security

Conveyor executes **arbitrary, untrusted code** by design. Treat it as a security-sensitive system.

### What the MVP does

- Job containers are **never privileged**, run as **uid 65534 (nobody)**, drop **all Linux capabilities**, set `no-new-privileges`, and have **no network** by default.
- CPU, memory (no swap), PID and wall-clock **limits** on every job, plus size limits on input files, logs and outputs.
- **No host directories are mounted** into job containers. I/O goes through the Docker archive API.
- Containers are **removed after every attempt**, and orphans are swept.
- Input file names are validated (`[A-Za-z0-9._-]`, no path traversal). Downloads only serve file names recorded on the job.
- Optional **image allowlist** (`ALLOWED_IMAGE_PREFIXES=conveyor/,registry.example.com/team/`).

### Known limitations (read this)

1. **The worker holds the Docker socket.** In `docker-compose.yml` the worker mounts `/var/run/docker.sock`. Anyone who controls the worker process can start a privileged container that mounts `/` and so **owns the host**. A bug in the worker is therefore a host-level vulnerability.
2. **Containers share the host kernel.** Namespaces and cgroups are not a strong security boundary. A kernel or runtime exploit (container escape) from a malicious image compromises the worker host and every other job on it.
3. **No authentication or multi-tenancy.** Anyone who can reach the API can run any image the worker can access, and see every job.
4. **Images aren't verified.** There's no signature checking or vulnerability scanning, and with `PULL_MISSING_IMAGES=true` users can run anything from a public registry.
5. **No disk quota** on a job's writable layer.

**Conveyor in this form is suitable for trusted users and portfolio and demo purposes. It is not safe to expose to untrusted users.**

### Toward production isolation

| Option | Isolation | Notes |
|---|---|---|
| Dedicated, disposable worker VMs | Strong (VM boundary) | One tenant per VM; recycle VMs often. The simplest real improvement. |
| **gVisor** (`runsc`) as the Docker runtime | Medium-strong | User-space kernel intercepts syscalls. Nearly a drop-in (`--runtime=runsc`). |
| **Kata Containers** | Strong | Each container runs in a lightweight VM, behind the same OCI interface. |
| **Firecracker microVMs** | Strong | What AWS Lambda/Fargate use: ~125 ms boot, minimal attack surface. Needs your own orchestration. |
| **ECS on Fargate** (`RunTask` per job) | Strong (AWS-managed microVM) | No Docker socket at all: the worker calls the ECS API instead of Docker. Slower start (~30–60 s) and per-task cost. |
| Rootless Docker / Podman on workers | Medium | Removes "socket = root on host" but not kernel-sharing risk. |

Each of these fits behind the same interface: the `DockerExecutor` is the only component that talks to Docker, so swapping it for a `FargateExecutor` or a `FirecrackerExecutor` doesn't touch the API, queue or state machine. Add authentication, per-tenant quotas and image signing (cosign) alongside.

## AWS deployment

The code already supports the AWS backends: set `QUEUE_DRIVER=sqs` and `STORAGE_DRIVER=s3`. The full target architecture is in **[docs/aws-deployment.md](docs/aws-deployment.md)**:

```mermaid
flowchart LR
    R53[Route 53] --> ALB[Application<br/>Load Balancer]
    ALB --> API[API service<br/>ECS Fargate]
    API --> RDS[(RDS<br/>PostgreSQL)]
    API --> SQS[[SQS]]
    API --> S3[(S3<br/>artifacts)]
    SQS --> WK[Worker instances<br/>EC2 Auto Scaling group]
    WK --> RDS
    WK --> S3
    WK --> DC{{Docker on<br/>each instance}}
    API -.logs.-> CW[CloudWatch Logs]
    WK -.logs.-> CW
```

## Project layout

```
server/                     API + worker (one TypeScript codebase, two entrypoints)
  prisma/schema.prisma      Job model and migrations
  src/api/                  Fastify app, routes, job service
  src/worker/               Queue consumer, job processor, reaper, state transitions
  src/docker/               Container executor and tar/log helpers
  src/queue/                JobQueue interface: BullMQ and SQS
  src/storage/              ArtifactStore interface: local disk and S3
  src/domain/               Request validation and lifecycle rules (pure)
  test/                     Vitest: unit, Docker integration, DB integration
web/                        React + Vite dashboard (served by nginx)
examples/                   Example workload images (not part of the platform)
docs/aws-deployment.md      AWS architecture and rollout plan
docker-compose.yml          The whole system locally
```

## Future improvements

- **Live log streaming** (attach to the container's log stream and push over SSE) instead of logs-at-exit.
- **Transactional outbox** so the database insert and the enqueue are atomic, instead of compensating on enqueue failure.
- **Authentication, API keys and per-tenant quotas.** Jobs scoped to their owner.
- **Stronger sandboxing**: a gVisor/Kata runtime, or a Fargate/Firecracker executor (see [Security](#security)).
- **Autoscaling workers** on SQS queue depth (`ApproximateNumberOfMessagesVisible` per instance).
- **Image pre-pulling and caching** on workers. Image digests pinned per job for reproducibility.
- **Webhooks** on completion, as an alternative to polling.
- **Per-attempt history** (a `job_attempts` table) instead of only the latest attempt's logs.
- **Priorities and scheduling** (separate queues per priority or resource class, GPU workers).
- **Infrastructure as code** (Terraform or CDK) for the AWS architecture.
- **Metrics**: queue depth, job latency percentiles and failure rates in CloudWatch or Prometheus.
