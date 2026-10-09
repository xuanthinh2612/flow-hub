import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { JobItem } from '../api/types';
import { JobTable } from './JobTable';
import { useFlowEvents } from '../api/events';

interface RecentJobsPanelProps {
  types: string[];
}

export const RecentJobsPanel: React.FC<RecentJobsPanelProps> = ({ types }) => {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const results = await Promise.all(
        types.map((t) => api<JobItem[]>(`/api/jobs?type=${t}&limit=8`).catch(() => []))
      );
      const combined = results
        .flat()
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 8);
      setJobs(combined);
    } catch {
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [types]);

  useEffect(() => {
    load();
  }, [load]);

  useFlowEvents((evt) => {
    if (evt.type === 'job') {
      load();
    }
  }, [load]);

  return (
    <div className="card">
      <h2>Kết quả gần đây</h2>
      {loading && !jobs.length ? (
        <p className="empty">Đang tải…</p>
      ) : (
        <JobTable jobs={jobs} onRefresh={load} />
      )}
    </div>
  );
};

