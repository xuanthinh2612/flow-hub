import React, { useState, useEffect, useCallback } from 'react';
import { JobItem, RpcLogEntry } from '../api/types';
import { api, mediaFile } from '../api/client';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { ago, typeLabel, fmt, innerOf, STATUS_LABEL } from '../utils/format';
import { reuseSpec } from '../utils/storage';
import { useNavigate } from 'react-router-dom';
import { MediaModalContent } from './MediaModal';
import { MediaVisual } from './MediaVisual';
import { useFlowEvents } from '../api/events';

interface JobModalContentProps {
  jobId: string;
  onDeleted?: () => void;
}

export const JobModalContent: React.FC<JobModalContentProps> = ({ jobId, onDeleted }) => {
  const [job, setJob] = useState<JobItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const { openModal, closeModal } = useModal();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const data = await api<JobItem>(`/api/jobs/${jobId}`);
      setJob(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
      toast(e.message, 'err');
    } finally {
      setLoading(false);
    }
  }, [jobId, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useFlowEvents((evt) => {
    if (evt.type === 'job' && evt.data?.id === jobId) {
      load();
    }
  }, [jobId, load]);

  if (loading && !job) return <p className="empty">Đang tải…</p>;
  if (error && !job) return <p className="err">{error}</p>;
  if (!job) return null;

  const pending = (job.ops || []).filter((o) => !o.done);
  const isActive = ['queued', 'running', 'polling'].includes(job.status);
  const canReuse = ['image', 'edit', 'character', 't2v', 'i2v', 'first_last', 'r2v'].includes(job.type);

  const handleAct = async (path: string, label: string) => {
    try {
      await api(`/api/jobs/${jobId}/${path}`, { method: 'POST' });
      toast(label, 'ok');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleDelete = async () => {
    try {
      await api(`/api/jobs/${jobId}`, { method: 'DELETE' });
      closeModal();
      toast('Đã xoá job', 'ok');
      if (onDeleted) onDeleted();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleReuse = () => {
    const page = reuseSpec(job.spec);
    if (page) {
      closeModal();
      navigate(`/${page}`);
    }
  };

  const openMediaDetail = (mediaId: string) => {
    openModal('Media', <MediaModalContent mediaId={mediaId} />);
  };

  return (
    <div>
      <div className="obs-head">
        <span className={`status ${job.status}`}>{STATUS_LABEL[job.status] || job.status}</span>
        <span className="mono">{job.model || ''}</span>
        <span className="muted">
          {ago(job.created_at)} · worker {job.worker_id || '—'}
        </span>
      </div>

      {job.prompt && <p>{job.prompt}</p>}
      {job.note && <p className="warn">{job.note}</p>}
      {job.error && <p className="err">{job.error}</p>}
      {(job.warnings || []).map((w, idx) => (
        <p key={idx} className="warn" style={{ margin: '2px 0' }}>
          ⚠ {w}
        </p>
      ))}

      {Boolean(job.results?.length) && (
        <>
          <div className="section-title">Kết quả</div>
          <div className="picker">
            {(job.results || [])
              .filter((r) => r.media_id)
              .map((r) => (
                <div
                  key={r.media_id}
                  className="pick"
                  title={r.media_id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => openMediaDetail(r.media_id)}
                >
                  <MediaVisual
                    media={{
                      id: r.media_id,
                      kind: r.kind || 'image',
                      poster_url: r.poster_url,
                    }}
                  />
                </div>
              ))}
          </div>
        </>
      )}

      {Boolean(job.ops?.length) && (
        <>
          <div className="section-title">Operation</div>
          <table className="list">
            <thead>
              <tr>
                <th></th>
                <th>Operation</th>
                <th>Trạng thái</th>
                <th>Vòng poll</th>
                <th>Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {job.ops!.map((o) => (
                <tr key={o.id}>
                  <td>{o.done ? '✓' : '…'}</td>
                  <td className="mono">
                    {o.label} · {o.id}
                  </td>
                  <td>{o.status || '—'}</td>
                  <td>{o.rounds || 0}</td>
                  <td className="muted">{o.complaint || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="actions" style={{ marginTop: '12px' }}>
        {isActive && (
          <button type="button" className="btn btn-sm" onClick={() => handleAct('cancel', 'Đã huỷ')}>
            Huỷ
          </button>
        )}
        {pending.length > 0 && !isActive && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => handleAct('repoll', 'Đang kiểm tra lại')}
          >
            Kiểm tra lại
          </button>
        )}
        {canReuse && (
          <button type="button" className="btn btn-sm" onClick={handleReuse}>
            Dùng lại cài đặt
          </button>
        )}
        <button type="button" className="btn btn-sm btn-danger" onClick={handleDelete}>
          Xoá
        </button>
      </div>

      <div className="section-title">Request đã gửi ({job.rpc_log?.length || 0})</div>
      {(job.rpc_log || []).map((entry: RpcLogEntry, i: number) => {
        const inner = innerOf(entry.body || '');
        return (
          <div key={i} className="card" style={{ padding: '10px', marginTop: '6px' }}>
            <div className="obs-head">
              <span className="obs-rpc">{entry.rpcid}</span>
              <span className="muted">
                captcha {entry.captcha_action || '—'} · HTTP {entry.status ?? '—'} ·{' '}
                {entry.duration_ms ?? '?'} ms · _reqid {entry.reqid}
              </span>
              {entry.error && <span className="err">{entry.error}</span>}
            </div>
            <pre className="body">{inner ? fmt(inner) : entry.body || ''}</pre>
            {entry.response && (
              <details>
                <summary className="muted" style={{ cursor: 'pointer' }}>
                  Response (rút gọn)
                </summary>
                <pre className="body">{entry.response}</pre>
              </details>
            )}
          </div>
        );
      })}

      {job.spec && (
        <details style={{ marginTop: '10px' }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>
            Spec (JSON)
          </summary>
          <pre className="body">{JSON.stringify(job.spec, null, 2)}</pre>
        </details>
      )}
    </div>
  );
};

