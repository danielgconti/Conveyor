import type { CreateJobRequest, JobDetail, JobStats, JobStatus, JobSummary } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.issues);
  return body as T;
}

export const api = {
  listJobs: (status?: JobStatus, limit = 100) =>
    request<{ jobs: JobSummary[]; total: number }>(
      `/api/jobs?limit=${limit}${status ? `&status=${status}` : ''}`,
    ),
  stats: () => request<JobStats>('/api/jobs/stats'),
  getJob: (id: string) => request<JobDetail>(`/api/jobs/${id}`),
  createJob: (body: CreateJobRequest) =>
    request<{ jobId: string; status: JobStatus }>('/api/jobs', { method: 'POST', body: JSON.stringify(body) }),
  cancelJob: (id: string) => request<JobDetail>(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  fileUrl: (id: string, kind: 'input' | 'output', name: string) =>
    `/api/jobs/${id}/files/${kind}/${encodeURIComponent(name)}`,
};
