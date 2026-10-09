import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api, withKey } from '../api/client';
import { ObservationItem, RpcItem, TemplateItem } from '../api/types';
import { clock, fmt, ago } from '../utils/format';
import { loadPref, savePref } from '../utils/storage';
import { useToast } from '../context/ToastContext';
import { useNavigate } from 'react-router-dom';
import { useFlowEvents } from '../api/events';

const PREFS_KEY = 'observe';

function rebuildFreq(rpc: any) {
  return JSON.stringify([
    [[rpc.rpcid, rpc.inner !== undefined ? JSON.stringify(rpc.inner) : rpc.raw, null, rpc.tag || 'generic']],
  ]);
}

export const ObservationPage: React.FC = () => {
  const [prefs, setPrefs] = useState(() =>
    loadPref(PREFS_KEY, {
      q: '',
      rpcid: '',
      source: '',
      kind: '',
      hidePolls: true,
      paused: false,
    })
  );

  const [rpcsList, setRpcsList] = useState<RpcItem[]>([]);
  const [rows, setRows] = useState<ObservationItem[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [detailsCache, setDetailsCache] = useState<Record<string, ObservationItem>>({});
  const [checkResults, setCheckResults] = useState<Record<string, any>>({});
  const [reachedEnd, setReachedEnd] = useState(false);
  const [armDelete, setArmDelete] = useState(false);
  const [loading, setLoading] = useState(true);

  const { toast, copy } = useToast();
  const navigate = useNavigate();

  const updatePrefs = (patch: Partial<typeof prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePref(PREFS_KEY, next);
      return next;
    });
  };

  const knownMap = useMemo(() => {
    return Object.fromEntries(rpcsList.filter((r) => r.name).map((r) => [r.rpcid, r]));
  }, [rpcsList]);

  const loadKnown = useCallback(async () => {
    try {
      const list = await api<RpcItem[]>('/api/rpcs');
      setRpcsList(list || []);
    } catch {
      setRpcsList([]);
    }
  }, []);

  const loadRows = useCallback(
    async (more = false, currentRows = rows) => {
      const q = new URLSearchParams({ limit: '150' });
      if (prefs.q) q.set('q', prefs.q);
      if (prefs.rpcid) q.set('rpcid', prefs.rpcid);
      if (prefs.source) q.set('source', prefs.source);
      if (prefs.kind) q.set('kind', prefs.kind);
      if (prefs.hidePolls) q.set('hide_polls', 'true');
      if (more && currentRows.length) q.set('before_id', currentRows[currentRows.length - 1].id);

      try {
        const batch = await api<ObservationItem[]>(`/api/observations?${q}`);
        const nextRows = more ? currentRows.concat(batch) : batch;
        setRows(nextRows);
        setReachedEnd(batch.length < 150);
      } catch {
        if (!more) setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [prefs, rows]
  );

  useEffect(() => {
    loadKnown();
  }, [loadKnown]);

  useEffect(() => {
    loadRows(false);
  }, [prefs.q, prefs.rpcid, prefs.source, prefs.kind, prefs.hidePolls]);

  useFlowEvents((evt) => {
    if (evt.type === 'observation' && !evt.data?.response) {
      if (!prefs.paused) {
        loadKnown();
        loadRows(false);
      }
    }
  }, [prefs.paused, loadKnown, loadRows]);

  const toggleExpand = async (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        if (!detailsCache[id]) {
          api<ObservationItem>(`/api/observations/${id}`).then((full) => {
            setDetailsCache((c) => ({ ...c, [id]: full }));
          });
        }
      }
      return next;
    });
  };

  const handleClearLog = async () => {
    if (!armDelete) {
      setArmDelete(true);
      return;
    }
    try {
      await api('/api/observations', { method: 'DELETE' });
      setArmDelete(false);
      setRows([]);
      toast('Đã xoá log', 'ok');
      loadRows(false);
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleCheckBuilder = async (obsId: string, rpcIndex: number) => {
    try {
      const res = await api(`/api/observations/${obsId}/check?rpc_index=${rpcIndex}`, {
        method: 'POST',
      });
      setCheckResults((prev) => ({ ...prev, [`${obsId}_${rpcIndex}`]: res }));
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleCreateTemplate = async (obsId: string, rpcIndex: number) => {
    try {
      const t = await api<TemplateItem>(`/api/observations/${obsId}/template`, {
        method: 'POST',
        body: { rpc_index: rpcIndex },
      });
      toast(`Đã tạo template #${t.id} (biến: ${(t.variables || []).join(', ') || 'không'})`, 'ok');
      navigate(`/templates?id=${t.id}`);
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const seenRpcs = rpcsList.filter((r) => r.count > 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Observation</h1>
          <p>
            Toàn bộ request batchexecute và lệnh mint reCAPTCHA mà tab Flow gửi (extension đọc thụ
            động). Request của trang được tự kiểm tra với builder; RPC/model/build mới sẽ báo ở Tổng
            quan.
          </p>
        </div>
        <div className="actions">
          <a className="btn btn-sm" href={withKey('/api/observations/export')} download="">
            Xuất JSON
          </a>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={handleClearLog}
            onBlur={() => setArmDelete(false)}
          >
            {armDelete ? 'Bấm lần nữa để xoá' : 'Xoá log'}
          </button>
        </div>
      </div>

      <div className="filters">
        <input
          className="input"
          placeholder="Tìm trong body: veo_, abra_, BELUGA, prompt, media id…"
          value={prefs.q}
          onChange={(e) => updatePrefs({ q: e.target.value })}
        />
        <select
          className="input"
          style={{ width: 'auto' }}
          value={prefs.source}
          onChange={(e) => updatePrefs({ source: e.target.value })}
        >
          <option value="">Mọi nguồn</option>
          <option value="page">Chỉ trang Flow</option>
          <option value="hub">Chỉ Flow Hub</option>
        </select>
        <select
          className="input"
          style={{ width: 'auto' }}
          value={prefs.kind}
          onChange={(e) => updatePrefs({ kind: e.target.value })}
        >
          <option value="">Mọi loại</option>
          <option value="batchexecute">batchexecute</option>
          <option value="recaptcha">reCAPTCHA</option>
        </select>
        <label className="switch">
          <input
            type="checkbox"
            checked={!!prefs.hidePolls}
            onChange={(e) => updatePrefs({ hidePolls: e.target.checked })}
          />
          Ẩn poll
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={!!prefs.paused}
            onChange={(e) => updatePrefs({ paused: e.target.checked })}
          />
          Tạm dừng cập nhật
        </label>
        <span className="muted">{rows.length} dòng</span>
      </div>

      <div className="chips" style={{ marginBottom: '10px' }}>
        <button
          type="button"
          className={`chip${prefs.rpcid === '' ? ' active' : ''}`}
          onClick={() => updatePrefs({ rpcid: '' })}
        >
          Tất cả RPC
        </button>
        {seenRpcs.map((r) => (
          <button
            key={r.rpcid}
            type="button"
            className={`chip${prefs.rpcid === r.rpcid ? ' active' : ''}${!r.name ? ' new' : ''}`}
            title={r.name || 'RPC chưa biết — có thể Flow vừa thêm'}
            onClick={() => updatePrefs({ rpcid: r.rpcid })}
          >
            {r.rpcid}
            <small>{r.count}</small>
          </button>
        ))}
        <button
          type="button"
          className={`chip${prefs.rpcid === 'reCAPTCHA' ? ' active' : ''}`}
          onClick={() => updatePrefs({ rpcid: 'reCAPTCHA' })}
        >
          reCAPTCHA
        </button>
      </div>

      <div>
        {rows.map((row) => {
          const isOpen = expandedIds.has(row.id);
          const isCaptcha = row.kind === 'recaptcha';
          const full = detailsCache[row.id] || row;

          return (
            <div key={row.id} className={`obs-row${isOpen ? ' open' : ''}`}>
              <div className="obs-sum" onClick={() => toggleExpand(row.id)}>
                <div className="obs-head">
                  <span className="mono muted">{clock(row.ts)}</span>
                  {(row.rpcids || []).map((r) => (
                    <span
                      key={r}
                      className={`obs-rpc${knownMap[r] || isCaptcha ? '' : ' new'}`}
                      title={knownMap[r]?.name || 'RPC chưa biết'}
                    >
                      {r}
                    </span>
                  ))}
                  <span>
                    {isCaptcha
                      ? `reCAPTCHA ${(row.params || {}).endpoint || ''}`
                      : (row.rpcids || []).map((r) => knownMap[r]?.name || 'RPC mới').join(' + ')}
                  </span>
                  <span className={`obs-src ${row.source}`}>
                    {row.source === 'hub' ? 'Flow Hub' : 'Trang'}
                  </span>
                  <span
                    className={`mono ${
                      row.error || (row.status && row.status >= 400) ? 'err' : 'ok'
                    }`}
                  >
                    {row.status ?? row.error ?? '…'}
                  </span>
                  {row.duration_ms !== null && row.duration_ms !== undefined && (
                    <span className="muted">{row.duration_ms}ms</span>
                  )}
                  {row.has_response && (
                    <span className="ok" style={{ fontSize: '11px' }}>
                      resp
                    </span>
                  )}
                  {(row.check_result || []).some((c) => c.supported && !c.ok) && (
                    <span className="err" style={{ fontSize: '11px' }}>
                      builder lệch
                    </span>
                  )}
                  {(row.check_result || []).some((c) => c.ok) && (
                    <span className="ok" style={{ fontSize: '11px' }}>
                      builder khớp
                    </span>
                  )}
                </div>

                {(row.summary?.keys?.length || row.summary?.prompt) && (
                  <div className="obs-sub">
                    {row.summary.keys?.length && (
                      <span className="mono">{row.summary.keys.slice(0, 8).join(' · ')}</span>
                    )}
                    {row.summary.prompt && <div>“{row.summary.prompt}”</div>}
                  </div>
                )}
              </div>

              {isOpen && (
                <div className="obs-detail">
                  {isCaptcha ? (
                    <div>
                      <dl className="kv">
                        <dt>Endpoint</dt>
                        <dd>{full.url}</dd>
                        <dt>Site key (k)</dt>
                        <dd>{full.params?.k}</dd>
                        <dt>Nguồn</dt>
                        <dd>
                          {full.source === 'hub'
                            ? `Flow Hub mint (action yêu cầu ${full.requested_action})`
                            : 'Trang Flow'}
                        </dd>
                        <dt>Action</dt>
                        <dd>{(full.actions || []).join(', ') || '— không thấy —'}</dd>
                        <dt>HTTP</dt>
                        <dd>{full.status}</dd>
                      </dl>

                      <div className="section-title">
                        Chuỗi trong body protobuf ({(full.strings || []).length})
                      </div>
                      <div className="actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => copy((full.strings || []).join('\n'))}
                        >
                          Copy
                        </button>
                      </div>
                      <pre className="body">{(full.strings || []).join('\n')}</pre>
                    </div>
                  ) : (
                    <div>
                      <dl className="kv">
                        <dt>URL</dt>
                        <dd>https://flow.google.com{full.path}</dd>
                        <dt>rpcids</dt>
                        <dd>{full.params?.rpcids}</dd>
                        <dt>source-path</dt>
                        <dd>{full.params?.['source-path']}</dd>
                        <dt>bl (build)</dt>
                        <dd>{full.params?.bl}</dd>
                        <dt>hl</dt>
                        <dd>{full.params?.hl}</dd>
                        <dt>_reqid</dt>
                        <dd>{full.params?._reqid}</dd>
                        <dt>form</dt>
                        <dd>
                          {(full.form_keys || []).join(', ')} (giá trị at không được gửi về server)
                        </dd>
                        <dt>f.req</dt>
                        <dd>{full.freq_size} ký tự</dd>
                        <dt>HTTP</dt>
                        <dd>{full.status ?? full.error}</dd>
                        <dt>Thời gian</dt>
                        <dd>{full.duration_ms !== null ? `${full.duration_ms} ms` : null}</dd>
                        <dt>Worker / tab</dt>
                        <dd>{`${full.worker_id || ''} / ${full.tab_id ?? ''}`}</dd>
                      </dl>

                      {Boolean(full.headers?.length) && (
                        <details style={{ marginTop: '8px' }}>
                          <summary style={{ cursor: 'pointer' }}>
                            <b>Headers ({full.headers!.length})</b>
                            <span className="muted mono">
                              {' · ' +
                                full
                                  .headers!.filter((x) => /^x-/i.test(x.name))
                                  .map((x) => x.name)
                                  .join(', ')}
                            </span>
                          </summary>
                          <div className="actions">
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() =>
                                copy(full.headers!.map((x) => `${x.name}: ${x.value}`).join('\n'))
                              }
                            >
                              Copy headers
                            </button>
                          </div>
                          <pre className="body">
                            {full.headers!.map((x) => `${x.name}: ${x.value}`).join('\n')}
                          </pre>
                        </details>
                      )}

                      {/* Check result */}
                      {(full.check_result || []).map((c, i) => (
                        <div key={i} style={{ marginTop: '8px' }}>
                          {!c.supported ? (
                            <p className="muted">Builder: {c.reason || 'không hỗ trợ'}</p>
                          ) : c.ok ? (
                            <p className="ok">
                              ✓ Builder của Flow Hub dựng ra body giống hệt trang
                              {c.rpcid ? ` (${c.rpcid})` : ''}.
                            </p>
                          ) : (
                            <div>
                              <p className="err">
                                ✕ Builder lệch với trang{c.rpcid ? ` (${c.rpcid})` : ''}
                                {c.error ? `: ${c.error}` : ''}
                              </p>
                              <table className="list">
                                <thead>
                                  <tr>
                                    <th>Vị trí</th>
                                    <th>Trang gửi</th>
                                    <th>Flow Hub dựng</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(c.diffs || []).map((d: any, di: number) => (
                                    <tr key={di}>
                                      <td className="mono">{d.path}</td>
                                      <td className="mono">{JSON.stringify(d.observed)}</td>
                                      <td className="mono">{JSON.stringify(d.built)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      ))}

                      {/* RPC blocks */}
                      {(full.rpcs || []).map((rpc, index) => {
                        const dynamicCheck = checkResults[`${full.id}_${index}`];
                        return (
                          <div key={index} style={{ marginTop: '10px' }}>
                            <div className="section-title">
                              {`${rpc.rpcid} — ${knownMap[rpc.rpcid]?.name || 'RPC chưa biết'} `}
                              <span className="muted">
                                {`· inner ${rpc.size} ký tự${
                                  rpc.tag && rpc.tag !== 'generic' ? ` · tag "${rpc.tag}"` : ''
                                }${rpc.shortened ? ' · chuỗi dài đã rút gọn khi lưu' : ''}`}
                              </span>
                            </div>
                            <div className="actions">
                              {rpc.inner !== undefined && (
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  onClick={() =>
                                    copy(JSON.stringify(rpc.inner), 'Đã copy inner JSON')
                                  }
                                >
                                  Copy inner JSON
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => copy(rebuildFreq(rpc), 'Đã copy f.req')}
                              >
                                Copy f.req
                              </button>
                              {rpc.inner !== undefined && (
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  onClick={() => handleCheckBuilder(full.id, index)}
                                >
                                  Kiểm tra builder
                                </button>
                              )}
                              {rpc.inner !== undefined && (
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  onClick={() => handleCreateTemplate(full.id, index)}
                                >
                                  Tạo template từ request này
                                </button>
                              )}
                            </div>

                            {dynamicCheck && (
                              <div style={{ marginTop: '6px' }}>
                                {(Array.isArray(dynamicCheck) ? dynamicCheck : [dynamicCheck]).map(
                                  (dc: any, dci: number) => (
                                    <div key={dci}>
                                      {dc.ok ? (
                                        <p className="ok">✓ Builder khớp hoàn toàn</p>
                                      ) : (
                                        <p className="err">
                                          ✕ Builder lệch: {dc.error || JSON.stringify(dc.diffs)}
                                        </p>
                                      )}
                                    </div>
                                  )
                                )}
                              </div>
                            )}

                            <pre className="body">
                              {rpc.inner !== undefined ? fmt(rpc.inner) : String(rpc.raw ?? '')}
                            </pre>
                          </div>
                        );
                      })}

                      {/* Response section */}
                      <div className="section-title">Response</div>
                      {!full.response ? (
                        <p className="hint">
                          Chưa có response — bật "Ghi cả response" trong Cài đặt (chỉ áp dụng cho
                          request sau khi bật).
                        </p>
                      ) : (
                        <div>
                          {(full.response.rpcs || []).map((r, ri) => (
                            <div key={ri} style={{ marginTop: '6px' }}>
                              <div>
                                <b className="mono">{r.rpcid}</b>
                                {r.error !== undefined && (
                                  <span className="err">
                                    {' '}
                                    · lỗi {r.error_text || JSON.stringify(r.error)}
                                  </span>
                                )}
                              </div>
                              {r.data !== undefined ? (
                                <pre className="body">{fmt(r.data)}</pre>
                              ) : r.data_size ? (
                                <p className="hint">
                                  Payload lớn ({r.data_size} ký tự) — xem raw.
                                </p>
                              ) : null}
                            </div>
                          ))}
                          <details style={{ marginTop: '8px' }}>
                            <summary className="muted" style={{ cursor: 'pointer' }}>
                              Raw response ({full.response.size} ký tự)
                            </summary>
                            <pre className="body">{full.response.raw || ''}</pre>
                          </details>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!loading && !rows.length && (
        <p className="empty">
          Chưa có request nào. Thao tác trên tab flow.google.com (có extension Flow Hub Worker) — mọi
          lệnh batchexecute sẽ hiện ở đây.
        </p>
      )}

      {!reachedEnd && rows.length > 0 && (
        <div style={{ marginTop: '12px' }}>
          <button type="button" className="btn" onClick={() => loadRows(true)}>
            Tải thêm
          </button>
        </div>
      )}
    </div>
  );
};

