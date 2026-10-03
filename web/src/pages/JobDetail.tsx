import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { formatDuration, formatTimestamp } from '../format';
import { ACTIVE_STATUSES, type JobDetail } from '../types';

const isImage = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

function Files({ job, kind }: { job: JobDetail; kind: 'input' | 'output' }) {
  const names = kind === 'input' ? job.inputFiles : job.outputFiles;
  if (names.length === 0) return null;
  return (
    <div className="files">
      {names.map((name) => {
        const url = api.fileUrl(job.id, kind, name);
        return (
          <a key={name} href={url} target="_blank" rel="noreferrer" className="file">
            {isImage(name) && <img src={url} alt={name} />}
            <span className="mono">{name}</span>
          </a>
        );
      })}
    </div>
  );
}

function Log({ title, text }: { title: string; text: string | null }) {
  return (
    <div>
      <h3>{title}</h3>
      {text ? <pre className="code log">{text}</pre> : <p className="muted">(empty)</p>}
    </div>
  );
}

export function JobDetailPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.getJob(id),
    // Poll while the job is in flight; stop once it reaches a terminal state.
    refetchInterval: (q) => (q.state.data && !ACTIVE_STATUSES.includes(q.state.data.status) ? false : 1000),
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelJob(id),
    onSuccess: (job) => queryClient.setQueryData(['job', id], job),
  });

  if (query.isLoading) return <p className="muted">Loading…</p>;
  if (query.isError) return <div className="alert error">{query.error.message}</div>;
  const job = query.data!;
  const active = ACTIVE_STATUSES.includes(job.status);

  const timeline = [
    { label: 'Created', at: job.createdAt },
    { label: 'Started', at: job.startedAt },
    { label: 'Completed', at: job.completedAt },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <Link to="/jobs" className="muted back">
            ← Jobs
          </Link>
          <h1 className="job-title">
            <span className="mono">{job.id}</span>
            <StatusBadge status={job.status} />
          </h1>
          <p className="mono muted">{job.image}</p>
        </div>
        {active && (
          <button className="button danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel job'}
          </button>
        )}
      </div>

      {cancel.isError && <div className="alert error">{cancel.error.message}</div>}
      {job.error && (
        <div className={`alert ${job.status === 'CANCELLED' ? 'info' : job.status === 'QUEUED' ? 'warn' : 'error'}`}>
          {job.status === 'QUEUED' && job.retryCount > 0 && <strong>Retrying. </strong>}
          {job.error}
        </div>
      )}

      <section className="detail-grid">
        <div className="panel">
          <h2>Execution</h2>
          <dl className="kv">
            <dt>Duration</dt>
            <dd>{formatDuration(job.durationMs)}</dd>
            <dt>Exit code</dt>
            <dd className="mono">{job.exitCode ?? '—'}</dd>
            <dt>Attempts</dt>
            <dd>
              {job.retryCount + (job.startedAt ? 1 : 0)} of {job.maxRetries + 1}
            </dd>
            <dt>Worker</dt>
            <dd className="mono truncate">{job.workerId ?? '—'}</dd>
          </dl>
          <ol className="timeline">
            {timeline.map((t) => (
              <li key={t.label} className={t.at ? 'done' : ''}>
                <span>{t.label}</span>
                <span className="muted">{formatTimestamp(t.at)}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="panel">
          <h2>Resource limits</h2>
          <dl className="kv">
            <dt>CPU</dt>
            <dd>
              {job.resources.cpu} core{job.resources.cpu === 1 ? '' : 's'}
            </dd>
            <dt>Memory</dt>
            <dd>{job.resources.memoryMb} MB</dd>
            <dt>Timeout</dt>
            <dd>{job.resources.timeoutSeconds} s</dd>
            <dt>Max retries</dt>
            <dd>{job.maxRetries}</dd>
          </dl>
        </div>
      </section>

      <section className="io-grid">
        <div className="panel">
          <h2>Input</h2>
          <pre className="code">{JSON.stringify(job.input, null, 2)}</pre>
          <Files job={job} kind="input" />
        </div>
        <div className="panel">
          <h2>Output</h2>
          {job.status === 'SUCCEEDED' || job.output !== null ? (
            <pre className="code">{job.output === null ? 'null' : JSON.stringify(job.output, null, 2)}</pre>
          ) : (
            <p className="muted">{active ? 'Waiting for the job to finish…' : 'No output.'}</p>
          )}
          <Files job={job} kind="output" />
        </div>
      </section>

      <section className="panel logs">
        <h2>Container logs</h2>
        <Log title="stdout" text={job.stdout} />
        <Log title="stderr" text={job.stderr} />
      </section>
    </>
  );
}
