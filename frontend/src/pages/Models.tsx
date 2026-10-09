import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { ModelsResponse, ModelFamily } from '../api/types';
import { ago } from '../utils/format';
import { useToast } from '../context/ToastContext';
import { useFlowEvents } from '../api/events';

const ASPECT_LABEL: Record<string, string> = { landscape: '16:9', portrait: '9:16' };

export const ModelsPage: React.FC = () => {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const [form, setForm] = useState({
    mode: 't2v',
    family: '',
    family_label: '',
    key: '',
    aspect: '',
    duration: '',
    resolution: '',
    status: 'unverified',
    note: '',
  });

  const load = useCallback(async () => {
    try {
      const res = await api<ModelsResponse>('/api/models');
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
    if (evt.type === 'alert') {
      load();
    }
  }, [load]);

  const handleSetDefault = async (mode: string, fam: ModelFamily) => {
    try {
      await api('/api/models/default', {
        method: 'POST',
        body: { mode, family: fam.family },
      });
      toast(`${fam.label} là mặc định cho ${mode}`, 'ok');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleStatusChange = async (variantId: string, key: string, newStatus: string) => {
    try {
      await api(`/api/models/${variantId}`, {
        method: 'PATCH',
        body: { status: newStatus },
      });
      toast(`${key}: ${newStatus}`, 'ok');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleDeleteVariant = async (variantId: string) => {
    try {
      await api(`/api/models/${variantId}`, { method: 'DELETE' });
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleAddModel = async () => {
    const payload: any = Object.fromEntries(
      Object.entries(form).filter(([, v]) => v !== '')
    );
    if (payload.duration) payload.duration = Number(payload.duration);

    try {
      await api('/api/models', { method: 'POST', body: payload });
      toast('Đã thêm', 'ok');
      setForm({
        mode: 't2v',
        family: '',
        family_label: '',
        key: '',
        aspect: '',
        duration: '',
        resolution: '',
        status: 'unverified',
        note: '',
      });
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  if (loading && !data) return <p className="empty">Đang tải…</p>;
  if (error && !data) return <p className="err">{error}</p>;
  if (!data) return null;

  const byMode: Record<string, ModelFamily[]> = {};
  for (const f of data.families) {
    (byMode[f.mode] = byMode[f.mode] || []).push(f);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Models</h1>
          <p>
            Danh mục wire id theo chế độ. Job chọn theo family + tỉ lệ/thời lượng/độ phân giải;
            "verified" = đã thấy trang Flow dùng.
          </p>
        </div>
      </div>

      <div>
        {Object.entries(data.modes).map(([mode, label]) => {
          const families = byMode[mode] || [];
          return (
            <div key={mode} className="card">
              <h2>{label}</h2>
              {families.map((fam) => (
                <div key={fam.family} style={{ marginBottom: '14px' }}>
                  <div className="obs-head" style={{ marginBottom: '6px' }}>
                    <b>{fam.label}</b>
                    <span className="mono muted">{fam.family}</span>
                    {fam.default ? (
                      <span className="status done">mặc định</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => handleSetDefault(mode, fam)}
                      >
                        Đặt mặc định
                      </button>
                    )}
                  </div>

                  <table className="list">
                    <thead>
                      <tr>
                        <th>Wire id</th>
                        <th>Tỉ lệ</th>
                        <th>Thời lượng</th>
                        <th>Độ phân giải</th>
                        <th>Trạng thái</th>
                        <th>Nguồn</th>
                        <th>Ghi chú</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {fam.variants.map((v) => (
                        <tr
                          key={v.id}
                          style={
                            v.source === 'observed'
                              ? { background: 'color-mix(in srgb, var(--warn) 8%, transparent)' }
                              : undefined
                          }
                        >
                          <td className="mono">{v.key}</td>
                          <td>{v.aspect ? ASPECT_LABEL[v.aspect] || v.aspect : 'mọi'}</td>
                          <td>{v.duration ? `${v.duration}s` : '—'}</td>
                          <td>{v.resolution || '—'}</td>
                          <td>
                            <select
                              className="input"
                              style={{ width: 'auto', padding: '2px 6px' }}
                              value={v.status}
                              onChange={(e) => handleStatusChange(v.id, v.key, e.target.value)}
                            >
                              <option value="verified">verified</option>
                              <option value="unverified">unverified</option>
                              <option value="disabled">disabled</option>
                            </select>
                          </td>
                          <td className="muted">
                            {v.source === 'observed' ? `thấy trên Flow ${ago(v.first_seen)}` : v.source}
                          </td>
                          <td className="muted" style={{ fontSize: '12px' }}>
                            {v.note || ''}
                            {v.last_seen && <div>lần cuối: {ago(v.last_seen)}</div>}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost btn-danger"
                              onClick={() => handleDeleteVariant(v.id)}
                            >
                              Xoá
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              {!families.length && <p className="muted">Chưa có model nào.</p>}
            </div>
          );
        })}
      </div>

      <div className="card" style={{ marginTop: '16px' }}>
        <h2>Thêm model thủ công</h2>
        <p className="hint">
          Model mà trang Flow dùng sẽ tự xuất hiện ở đây (nguồn "observed"). Chỉ cần thêm tay khi
          muốn thử một wire id trước khi thấy nó trong traffic.
        </p>
        <div className="grid-2">
          <select
            className="input"
            value={form.mode}
            onChange={(e) => setForm({ ...form, mode: e.target.value })}
          >
            <option value="image">image</option>
            <option value="t2v">t2v</option>
            <option value="i2v">i2v</option>
            <option value="first_last">first_last</option>
            <option value="r2v">r2v</option>
          </select>
          <input
            className="input mono"
            placeholder="wire id, VD: veo_3_1_t2v_quality"
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value.trim() })}
          />
          <input
            className="input mono"
            placeholder="family (trống = theo wire id)"
            value={form.family}
            onChange={(e) => setForm({ ...form, family: e.target.value.trim() })}
          />
          <input
            className="input mono"
            placeholder="tên hiển thị"
            value={form.family_label}
            onChange={(e) => setForm({ ...form, family_label: e.target.value.trim() })}
          />
          <select
            className="input"
            value={form.aspect}
            onChange={(e) => setForm({ ...form, aspect: e.target.value })}
          >
            <option value="">mọi tỉ lệ</option>
            <option value="landscape">16:9</option>
            <option value="portrait">9:16</option>
          </select>
          <input
            className="input mono"
            placeholder="thời lượng (s), VD 8"
            value={form.duration}
            onChange={(e) => setForm({ ...form, duration: e.target.value.trim() })}
          />
          <select
            className="input"
            value={form.resolution}
            onChange={(e) => setForm({ ...form, resolution: e.target.value })}
          >
            <option value="">không</option>
            <option value="720p">720p</option>
            <option value="360p">360p</option>
          </select>
          <select
            className="input"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
          >
            <option value="unverified">unverified</option>
            <option value="verified">verified</option>
          </select>
        </div>
        <div className="actions" style={{ marginTop: '10px' }}>
          <button type="button" className="btn btn-primary" onClick={handleAddModel}>
            Thêm
          </button>
        </div>
      </div>
    </div>
  );
};

