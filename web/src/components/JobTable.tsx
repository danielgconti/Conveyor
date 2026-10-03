import { useNavigate } from 'react-router-dom';
import { formatDuration, formatRelative, shortId } from '../format';
import type { JobSummary } from '../types';
import { StatusBadge } from './StatusBadge';

export function JobTable({ jobs, empty }: { jobs: JobSummary[]; empty: React.ReactNode }) {
  const navigate = useNavigate();
  if (jobs.length === 0) return <div className="empty">{empty}</div>;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Image</th>
            <th>Status</th>
            <th>Created</th>
            <th className="num">Duration</th>
            <th className="num">Retries</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr
              key={job.id}
              onClick={() => navigate(`/jobs/${job.id}`)}
              onKeyDown={(e) => e.key === 'Enter' && navigate(`/jobs/${job.id}`)}
              tabIndex={0}
              className="clickable"
            >
              <td className="mono">{shortId(job.id)}</td>
              <td className="mono truncate" title={job.image}>
                {job.image}
              </td>
              <td>
                <StatusBadge status={job.status} />
              </td>
              <td title={new Date(job.createdAt).toLocaleString()}>{formatRelative(job.createdAt)}</td>
              <td className="num">{formatDuration(job.durationMs)}</td>
              <td className="num">
                {job.retryCount}/{job.maxRetries}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
