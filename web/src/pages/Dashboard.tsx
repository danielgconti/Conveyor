import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { JobTable } from '../components/JobTable';

export function Dashboard() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 2000 });
  const recent = useQuery({ queryKey: ['jobs', 'recent'], queryFn: () => api.listJobs(undefined, 10), refetchInterval: 2000 });

  const s = stats.data;
  const cards = [
    { label: 'Total jobs', value: s?.TOTAL, tone: 'neutral' },
    { label: 'Queued', value: s?.QUEUED, tone: 'queued' },
    { label: 'Running', value: s?.RUNNING, tone: 'running' },
    { label: 'Completed', value: s?.SUCCEEDED, tone: 'succeeded' },
    { label: 'Failed', value: s ? s.FAILED + s.TIMED_OUT : undefined, tone: 'failed', hint: s?.TIMED_OUT ? `${s.TIMED_OUT} timed out` : undefined },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Live view of the job queue. Refreshes every 2 seconds.</p>
        </div>
        <Link to="/submit" className="button primary">
          Submit job
        </Link>
      </div>

      {stats.isError && <div className="alert error">Can't reach the API: {stats.error.message}</div>}

      <section className="stat-grid">
        {cards.map((card) => (
          <div key={card.label} className={`stat stat-${card.tone}`}>
            <div className="stat-label">{card.label}</div>
            <div className="stat-value">{card.value ?? '–'}</div>
            {card.hint && <div className="stat-hint">{card.hint}</div>}
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Recent jobs</h2>
          <Link to="/jobs">View all →</Link>
        </div>
        <JobTable
          jobs={recent.data?.jobs ?? []}
          empty={
            <>
              No jobs yet. <Link to="/submit">Submit your first job</Link>.
            </>
          }
        />
      </section>
    </>
  );
}
