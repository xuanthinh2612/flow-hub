import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { OverviewData } from '../api/types';
import { ago } from '../utils/format';
import { JobTable } from '../components/JobTable';
import { Link } from 'react-router-dom';
import { useFlowEvents } from '../api/events';

const KIND_LABEL: Record<string, string> = {
  rpc_new: 'RPC mới',
  model_new: 'Model mới',
  model_verified: 'Xác minh',
  build: 'Build',
  builder_drift: 'Builder lệch',
  captcha_action: 'Captcha',
  observe: 'Observation',
};

export const OverviewPage: React.FC = () => {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<OverviewData>('/api/overview');
      setData(res);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useFlowEvents((evt) => {
    if (['worker', 'job', 'alert'].includes(evt.type)) {
      load();
    }
  }, [load]);

  const markAlertsSeen = async () => {
    try {
      await api('/api/alerts/seen', { method: 'POST', body: {} });
      load();
    } catch {
      /* ignore */
    }
  };

  if (loading && !data) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1>Tổng quan</h1>
            <p>Trạng thái worker, job và những thay đổi của Flow mà Observation phát hiện.</p>
          </div>
        </div>
        <p className="empty">Đang tải…</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1>Tổng quan</h1>
            <p>Trạng thái worker, job và những thay đổi của Flow mà Observation phát hiện.</p>
          </div>
        </div>
        <p className="err">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  const online = (data.workers || []).filter((w) => w.online);
  const active =
    (data.job_counts?.queued || 0) +
    (data.job_counts?.running || 0) +
    (data.job_counts?.polling || 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Tổng quan</h1>
          <p>Trạng thái worker, job và những thay đổi của Flow mà Observation phát hiện.</p>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className={`v ${online.length ? 'ok' : 'err'}`}>{online.length}</div>
          <div className="k">worker online</div>
        </div>
        <div className="stat">
          <div className={`v ${active ? 'warn' : ''}`}>{active}</div>
          <div className="k">job đang chạy</div>
        </div>
        <div className="stat">
          <div className="v">{data.job_counts?.done || 0}</div>
          <div className="k">job xong</div>
        </div>
        <div className="stat">
          <div className={`v ${data.job_counts?.failed ? 'err' : ''}`}>
            {data.job_counts?.failed || 0}
          </div>
          <div className="k">job lỗi</div>
        </div>
        <div className="stat">
          <div className="v">{data.media_count}</div>
          <div className="k">media</div>
        </div>
        <div className="stat">
          <div className="v">{data.observation_count}</div>
          <div className="k">observation</div>
        </div>
      </div>

      {!online.length && (
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          <h2>Chưa có worker nào kết nối</h2>
          <p>
            Cài extension trong thư mục <span className="mono">extension/</span> (chrome://extensions → Developer mode → Load unpacked), mở popup và dán URL + token ở trang{' '}
            <Link to="/settings">Cài đặt</Link>. Sau đó mở flow.google.com, đăng nhập và vào một project.
          </p>
        </div>
      )}

      <div className="cols" style={{ marginTop: '14px' }}>
        <div>
          <div className="card">
            <h2>Workers</h2>
            {data.workers?.length ? (
              data.workers.map((w) => (
                <div key={w.id} className="alert-row">
                  <span className={`pill ${w.online ? 'ok' : 'err'}`}>
                    {w.online ? '● online' : '○ offline'}
                  </span>
                  <div>
                    <b>{w.label}</b>
                    <span className="muted mono">{` ${w.id.slice(0, 8)} · v${w.version || '?'}`}</span>
                    <div className="muted" style={{ fontSize: '12px' }}>
                      {`${w.flow?.tabs || 0} tab Flow · project ${
                        (w.flow?.projects || [])[0]?.projectId || '—'
                      } · ${w.online ? `kết nối ${ago(w.connected_at)}` : `lần cuối ${ago(w.last_seen)}`}`}
                      {w.stats?.rpcs !== undefined
                        ? ` · ${w.stats.rpcs} RPC, ${w.stats.observed} quan sát`
                        : ''}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">Chưa có.</p>
            )}
          </div>

          <div className="card">
            <h2>Job gần đây</h2>
            <JobTable jobs={data.recent_jobs || []} onRefresh={load} />
          </div>
        </div>

        <div className="card">
          <div className="obs-head" style={{ justifyContent: 'space-between', marginBottom: '6px' }}>
            <h2 style={{ margin: 0 }}>
              {`Cảnh báo thay đổi của Flow${data.alerts_unseen ? ` (${data.alerts_unseen} mới)` : ''}`}
            </h2>
            {Boolean(data.alerts_unseen) && (
              <button type="button" className="btn btn-sm" onClick={markAlertsSeen}>
                Đánh dấu đã xem
              </button>
            )}
          </div>
          <p className="hint">
            {`Build Flow gần nhất: ${data.last_build || 'chưa thấy'} — cảnh báo khi trang dùng RPC/model/build mới hoặc builder lệch với request thật.`}
          </p>
          {data.alerts?.length ? (
            data.alerts.map((a, i) => (
              <div key={a.id || i} className={`alert-row${a.seen ? ' seen' : ''}`}>
                <span className="kind">{KIND_LABEL[a.kind] || a.kind}</span>
                <div>
                  <b>{a.title}</b>
                  {a.detail && (
                    <div className="muted" style={{ fontSize: '12px' }}>
                      {a.detail}
                    </div>
                  )}
                  <div className="muted" style={{ fontSize: '11px' }}>
                    {ago(a.ts)}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="muted">Chưa có cảnh báo — Flow chưa thay đổi gì so với những gì Flow Hub biết.</p>
          )}
        </div>
      </div>
    </div>
  );
};

