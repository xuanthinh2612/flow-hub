import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { JobItem } from '../api/types';
import { JobTable } from '../components/JobTable';
import { useToast } from '../context/ToastContext';
import { useFlowEvents } from '../api/events';

const CHIPS = ['all', 'active', 'done', 'partial', 'failed', 'timeout', 'canceled'];

export const JobsPage: React.FC = () => {
  const [filter, setFilter] = useState('all');
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { toast } = useToast();

  const load = useCallback(async () => {
    const q = filter === 'all' ? '' : `status=${filter}&`;
    try {
      const data = await api<JobItem[]>(`/api/jobs?${q}limit=200`);
      setJobs(data || []);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  useFlowEvents((evt) => {
    if (evt.type === 'job') {
      load();
    }
  }, [load]);

  const handleClearAll = async () => {
    if (!window.confirm('Xóa tất cả jobs?')) return;
    try {
      await api('/api/jobs', { method: 'DELETE' });
      toast('Đã xóa tất cả', 'ok');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Jobs</h1>
          <p>
            Mọi lệnh tạo đã gửi qua worker. Bấm một dòng để xem body, response và trạng thái từng
            operation.
          </p>
        </div>
        <button type="button" className="btn btn-sm btn-danger" onClick={handleClearAll}>
          Xóa tất cả
        </button>
      </div>

      <div className="seg">
        {CHIPS.map((c) => (
          <button
            key={c}
            type="button"
            className={`chip${c === filter ? ' active' : ''}`}
            onClick={() => setFilter(c)}
          >
            {c === 'all' ? 'Tất cả' : c === 'active' ? 'Đang chạy' : c}
          </button>
        ))}
      </div>

      <div className="card">
        {loading && !jobs.length ? (
          <p className="empty">Đang tải…</p>
        ) : error ? (
          <p className="err">{error}</p>
        ) : (
          <JobTable jobs={jobs} onRefresh={load} />
        )}
      </div>
    </div>
  );
};

