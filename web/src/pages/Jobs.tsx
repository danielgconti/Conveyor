import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { JobTable } from '../components/JobTable';
import { JOB_STATUSES, type JobStatus } from '../types';

export function JobsPage() {
  const [params, setParams] = useSearchParams();
  const status = (JOB_STATUSES as readonly string[]).includes(params.get('status') ?? '')
    ? (params.get('status') as JobStatus)
    : undefined;

  const jobs = useQuery({
    queryKey: ['jobs', status ?? 'all'],
    queryFn: () => api.listJobs(status),
    refetchInterval: 2000,
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Jobs</h1>
          <p className="muted">{jobs.data ? `${jobs.data.total} job${jobs.data.total === 1 ? '' : 's'}` : ' '}</p>
        </div>
        <Link to="/submit" className="button primary">
          Submit job
        </Link>
      </div>

      <div className="filters" role="tablist">
        {[undefined, ...JOB_STATUSES].map((s) => (
          <button
            key={s ?? 'all'}
            role="tab"
            aria-selected={s === status}
            className={`chip ${s === status ? 'active' : ''}`}
            onClick={() => setParams(s ? { status: s } : {})}
          >
            {s ? s.replace('_', ' ').toLowerCase() : 'all'}
          </button>
        ))}
      </div>

      {jobs.isError && <div className="alert error">{jobs.error.message}</div>}
      <section className="panel">
        <JobTable jobs={jobs.data?.jobs ?? []} empty={jobs.isLoading ? 'Loading…' : 'No jobs match this filter.'} />
      </section>
    </>
  );
}
