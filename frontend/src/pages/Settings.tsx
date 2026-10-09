import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { SettingsData, WorkerInfo } from '../api/types';
import { useToast } from '../context/ToastContext';

export const SettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tokenType, setTokenType] = useState<'password' | 'text'>('password');
  const [draft, setDraft] = useState<Partial<SettingsData>>({});

  const { toast, copy } = useToast();

  const load = useCallback(async () => {
    try {
      const [s, w] = await Promise.all([
        api<SettingsData>('/api/settings'),
        api<WorkerInfo[]>('/api/workers'),
      ]);
      setSettings(s);
      setWorkers(w);
      setDraft(s);
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

  if (loading && !settings) return <p className="empty">Đang tải…</p>;
  if (error && !settings) return <p className="err">{error}</p>;
  if (!settings) return null;

  const projects = [
    ...new Set(workers.flatMap((w) => (w.flow?.projects || []).map((p) => p.projectId))),
  ];
  const onlineWorkers = workers.filter((w) => w.online);

  const handleSave = async () => {
    try {
      await api('/api/settings', { method: 'PATCH', body: draft });
      toast('Đã lưu', 'ok');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleRotateToken = async () => {
    try {
      await api('/api/settings/rotate-worker-token', { method: 'POST' });
      toast('Đã đổi token — dán token mới vào extension', 'ok');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const curl = `curl -X POST http://${window.location.host}/api/jobs -H "Content-Type: application/json"${
    settings.auth_enabled ? ' -H "X-API-Key: <API key>"' : ''
  } \\\n  -d '{"type":"t2v","prompt":"một cô gái đàn hát bên cửa sổ","aspect":"16:9"}'`;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Cài đặt</h1>
          <p>Ghép nối extension, project mặc định, Observation và API.</p>
        </div>
      </div>

      <div className="cols">
        <div>
          <div className="card">
            <h2>Ghép nối extension (worker)</h2>
            <p className="hint">
              Mở popup của extension "Flow Hub Worker" → dán 2 giá trị dưới → Lưu &amp; kết nối.
            </p>

            <div className="field">
              <div className="field-label">URL WebSocket</div>
              <div className="inline">
                <input className="input mono" value={settings.ws_url} readOnly />
                <button type="button" className="btn btn-sm" onClick={() => copy(settings.ws_url)}>
                  Copy
                </button>
              </div>
            </div>

            <div className="field">
              <div className="field-label">Token</div>
              <div className="inline">
                <input
                  className="input mono"
                  value={settings.worker_token}
                  readOnly
                  type={tokenType}
                  onFocus={() => setTokenType('text')}
                  onBlur={() => setTokenType('password')}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => copy(settings.worker_token, 'Đã copy token')}
                >
                  Copy
                </button>
                {!settings.worker_token_from_env && (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={handleRotateToken}
                  >
                    Đổi token
                  </button>
                )}
              </div>
            </div>

            <p className="hint">
              Worker đang kết nối:{' '}
              {onlineWorkers.map((w) => w.label).join(', ') || 'chưa có'}
            </p>
          </div>

          <div className="card">
            <h2>API cho server khác</h2>
            <p className="hint">
              {settings.auth_enabled
                ? 'Xác thực: BẬT — gửi header X-API-Key (key in ra console khi server khởi động, hoặc FLOWHUB_API_KEY trong .env).'
                : 'Xác thực: TẮT (server chỉ nghe trên localhost). Đặt FLOWHUB_AUTH=on hoặc mở ra mạng ngoài sẽ tự bật.'}
            </p>
            <pre className="body">{curl}</pre>
            <p>
              <a href="/docs" target="_blank" rel="noopener noreferrer">
                Mở tài liệu API (Swagger) ↗
              </a>{' '}
              — webhook: thêm "webhook_url" vào job, server POST kết quả khi xong.
            </p>
          </div>
        </div>

        <div className="card">
          <h2>Tuỳ chọn</h2>

          <div className="field">
            <div className="field-label">Flow project ID mặc định</div>
            <input
              className="input mono"
              value={draft.project_id || ''}
              placeholder="trống = dùng project đang mở trên tab Flow của worker"
              onChange={(e) => setDraft({ ...draft, project_id: e.target.value.trim() })}
            />
            {projects.length > 0 ? (
              <div className="chips" style={{ marginTop: '6px' }}>
                {projects.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="chip mono"
                    onClick={() => setDraft({ ...draft, project_id: p })}
                  >
                    {p}
                  </button>
                ))}
              </div>
            ) : (
              <p className="hint">Chưa thấy project nào trên tab Flow của worker.</p>
            )}
          </div>

          <div className="field">
            <label className="switch">
              <input
                type="checkbox"
                checked={!!draft.observe_enabled}
                onChange={(e) => setDraft({ ...draft, observe_enabled: e.target.checked })}
              />
              Ghi Observation (request của trang Flow)
            </label>
          </div>

          <div className="field">
            <label className="switch">
              <input
                type="checkbox"
                checked={!!draft.observe_responses}
                onChange={(e) => setDraft({ ...draft, observe_responses: e.target.checked })}
              />
              Ghi cả response (chrome.debugger)
            </label>
            <p className="hint">
              Chrome sẽ hiện thanh "đang debug trình duyệt" trên máy worker; đóng thanh đó = tự tắt.
            </p>
          </div>

          <div className="field">
            <label className="switch">
              <input
                type="checkbox"
                checked={!!draft.download_media}
                onChange={(e) => setDraft({ ...draft, download_media: e.target.checked })}
              />
              Tải ảnh / video về server khi xong
            </label>
          </div>

          <div className="grid-2">
            <div className="field">
              <div className="field-label">Chu kỳ poll video (giây)</div>
              <input
                className="input"
                type="number"
                step="any"
                value={draft.poll_interval_s ?? ''}
                onChange={(e) => setDraft({ ...draft, poll_interval_s: Number(e.target.value) })}
              />
              <p className="hint">Giao diện Flow dùng ~5 giây</p>
            </div>

            <div className="field">
              <div className="field-label">Giãn cách giữa các lệnh tạo (giây)</div>
              <input
                className="input"
                type="number"
                step="any"
                value={draft.min_submit_gap_s ?? ''}
                onChange={(e) => setDraft({ ...draft, min_submit_gap_s: Number(e.target.value) })}
              />
              <p className="hint">Không bắn liên tục — giảm rủi ro "unusual activity"</p>
            </div>

            <div className="field">
              <div className="field-label">Timeout video mặc định (phút)</div>
              <input
                className="input"
                type="number"
                step="any"
                value={draft.job_timeout_min ?? ''}
                onChange={(e) => setDraft({ ...draft, job_timeout_min: Number(e.target.value) })}
              />
            </div>

            <div className="field">
              <div className="field-label">Chờ worker tối đa (giây)</div>
              <input
                className="input"
                type="number"
                step="any"
                value={draft.wait_worker_s ?? ''}
                onChange={(e) => setDraft({ ...draft, wait_worker_s: Number(e.target.value) })}
              />
            </div>

            <div className="field">
              <div className="field-label">Giữ tối đa bao nhiêu observation</div>
              <input
                className="input"
                type="number"
                step="any"
                value={draft.max_observations ?? ''}
                onChange={(e) => setDraft({ ...draft, max_observations: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={handleSave}>
              Lưu
            </button>
          </div>

          <p className="hint" style={{ marginTop: '12px' }}>
            Flow Hub {settings.version} · build Flow gần nhất: {settings.last_build || 'chưa thấy'}
          </p>
        </div>
      </div>
    </div>
  );
};

