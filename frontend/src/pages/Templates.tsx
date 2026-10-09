import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { TemplateItem } from '../api/types';
import { ago, fmt } from '../utils/format';
import { useToast } from '../context/ToastContext';
import { useSearchParams } from 'react-router-dom';

export const TemplatesPage: React.FC = () => {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateItem | null>(null);
  const [draft, setDraft] = useState<Partial<TemplateItem>>({});
  const [innerJsonStr, setInnerJsonStr] = useState<string>('');
  const [variablesValues, setVariablesValues] = useState<Record<string, string>>({});
  const [renderBodyOutput, setRenderBodyOutput] = useState<string | null>(null);

  // Raw RPC state
  const [rawRpcId, setRawRpcId] = useState('as29s');
  const [rawCaptcha, setRawCaptcha] = useState('');
  const [rawInnerStr, setRawInnerStr] = useState('["<media id>"]');
  const [rawOutput, setRawOutput] = useState<string | null>(null);
  const [rawSending, setRawSending] = useState(false);

  const [searchParams] = useSearchParams();
  const { toast } = useToast();

  const loadTemplates = useCallback(async () => {
    try {
      const items = await api<TemplateItem[]>('/api/templates');
      setTemplates(items || []);
      return items || [];
    } catch {
      setTemplates([]);
      return [];
    }
  }, []);

  const openTemplate = useCallback(async (id: number) => {
    try {
      const t = await api<TemplateItem>(`/api/templates/${id}`);
      setSelectedTemplate(t);
      setDraft({
        name: t.name,
        rpcid: t.rpcid,
        captcha_action: t.captcha_action || '',
        result_kind: t.result_kind,
        note: t.note || '',
      });
      setInnerJsonStr(JSON.stringify(t.inner, null, 1));
      setVariablesValues({});
      setRenderBodyOutput(null);
    } catch (e: any) {
      toast(e.message, 'err');
    }
  }, [toast]);

  useEffect(() => {
    loadTemplates().then((items) => {
      const wantedId = Number(searchParams.get('id'));
      if (wantedId) {
        openTemplate(wantedId);
      } else if (items.length > 0 && !selectedTemplate) {
        // optionally keep empty or open first
      }
    });
  }, [searchParams]);

  const handleSaveTemplate = async () => {
    if (!selectedTemplate) return;
    let parsedInner: any;
    try {
      parsedInner = JSON.parse(innerJsonStr);
    } catch (e: any) {
      toast(`inner không phải JSON hợp lệ: ${e.message}`, 'err');
      return;
    }

    try {
      const saved = await api<TemplateItem>(`/api/templates/${selectedTemplate.id}`, {
        method: 'PATCH',
        body: {
          ...draft,
          captcha_action: draft.captcha_action || null,
          inner: parsedInner,
        },
      });
      setSelectedTemplate(saved);
      toast('Đã lưu template', 'ok');
      loadTemplates();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleDeleteTemplate = async () => {
    if (!selectedTemplate) return;
    try {
      await api(`/api/templates/${selectedTemplate.id}`, { method: 'DELETE' });
      setSelectedTemplate(null);
      toast('Đã xoá template', 'ok');
      loadTemplates();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleRunTemplate = async () => {
    if (!selectedTemplate) return;
    try {
      const job = await api<{ id: string }>('/api/jobs', {
        method: 'POST',
        body: {
          type: 'template',
          template_id: selectedTemplate.id,
          prompt: variablesValues.prompt || null,
          variables: variablesValues,
        },
      });
      toast(`Đã gửi job ${job.id} — xem ở Jobs`, 'ok');
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleRenderBody = async () => {
    if (!selectedTemplate) return;
    try {
      const r = await api<{ rpcid: string; inner: any }>(
        `/api/templates/${selectedTemplate.id}/render`,
        {
          method: 'POST',
          body: { variables: { prompt: 'PROMPT', ...variablesValues } },
        }
      );
      setRenderBodyOutput(`${r.rpcid}\ninner =\n${fmt(r.inner)}`);
    } catch (e: any) {
      setRenderBodyOutput(`⚠ ${e.message}`);
    }
  };

  const handleSendRawRpc = async () => {
    let inner: any;
    try {
      inner = JSON.parse(rawInnerStr);
    } catch (e: any) {
      toast(`inner không phải JSON: ${e.message}`, 'err');
      return;
    }

    setRawSending(true);
    setRawOutput('Đang gửi…');
    try {
      const r = await api<any>('/api/rpc', {
        method: 'POST',
        body: {
          rpcid: rawRpcId,
          inner,
          captcha_action: rawCaptcha || null,
        },
      });
      let outText = `HTTP ${r.status ?? '—'}${r.error ? ` · lỗi ${r.error}` : ''}\n\n`;
      if (r.decoded?.rpcs) {
        outText += r.decoded.rpcs
          .map(
            (x: any) =>
              `${x.rpcid}${x.error_text ? ` · LỖI ${x.error_text}` : ''}\n${
                x.data !== undefined ? fmt(x.data) : ''
              }`
          )
          .join('\n\n');
        outText += '\n\n';
      }
      outText += `Raw:\n${r.text || ''}`;
      setRawOutput(outText);
    } catch (e: any) {
      setRawOutput(`⚠ ${e.message}`);
    } finally {
      setRawSending(false);
    }
  };

  const variables = (selectedTemplate?.variables || []).filter((v) => v !== 'project_id');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Templates &amp; RPC</h1>
          <p>
            Khi Flow đổi body trước khi kịp sửa builder: lấy một request thật của trang làm template
            rồi chạy với prompt mới.
          </p>
        </div>
      </div>

      <div className="cols">
        <div>
          <div className="card">
            <h2>Templates</h2>
            {templates.length > 0 ? (
              templates.map((t) => (
                <div
                  key={t.id}
                  className="obs-row"
                  style={{
                    cursor: 'pointer',
                    borderColor: selectedTemplate?.id === t.id ? 'var(--accent)' : undefined,
                  }}
                  onClick={() => openTemplate(t.id)}
                >
                  <div className="obs-sum">
                    <div className="obs-head">
                      <span className="obs-rpc">{t.rpcid}</span>
                      <b>{t.name}</b>
                    </div>
                    <div className="obs-sub">
                      {`biến: ${(t.variables || []).join(', ') || '—'} · ${t.result_kind} · ${ago(
                        t.updated_at
                      )}`}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="empty">
                Chưa có template. Mở Observation → một request của trang → "Tạo template từ request
                này".
              </p>
            )}
          </div>

          <div className="card" style={{ marginTop: '14px' }}>
            <h2>Gửi RPC thủ công</h2>
            <p className="hint">
              Gửi một RPC bất kỳ qua worker để thử khi Flow đổi API. Body có "__CAPTCHA__" sẽ được
              mint token (action tự chọn theo RPC nếu để trống).
            </p>
            <div className="grid-2">
              <div className="field">
                <div className="field-label">RPC id</div>
                <input
                  className="input mono"
                  value={rawRpcId}
                  onChange={(e) => setRawRpcId(e.target.value.trim())}
                />
              </div>
              <div className="field">
                <div className="field-label">Captcha action</div>
                <input
                  className="input mono"
                  placeholder="trống = tự chọn · none = không"
                  value={rawCaptcha}
                  onChange={(e) => setRawCaptcha(e.target.value.trim())}
                />
              </div>
            </div>
            <div className="field">
              <div className="field-label">Inner JSON</div>
              <textarea
                className="input code"
                rows={6}
                value={rawInnerStr}
                onChange={(e) => setRawInnerStr(e.target.value)}
              />
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={rawSending}
                onClick={handleSendRawRpc}
              >
                Gửi
              </button>
            </div>
            {rawOutput && <pre className="body">{rawOutput}</pre>}
          </div>
        </div>

        <div className="card">
          {!selectedTemplate ? (
            <p className="empty">
              Chọn một template bên trái, hoặc tạo từ một request trong Observation.
            </p>
          ) : (
            <div>
              <h2>Template #{selectedTemplate.id}</h2>
              <p className="hint">
                {`${selectedTemplate.note || ''} · tạo ${ago(selectedTemplate.created_at)}${
                  selectedTemplate.observation_id
                    ? ` · từ observation #${selectedTemplate.observation_id}`
                    : ''
                }`}
              </p>

              <div className="grid-2">
                <div className="field">
                  <div className="field-label">Tên</div>
                  <input
                    className="input"
                    value={draft.name || ''}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </div>
                <div className="field">
                  <div className="field-label">RPC id</div>
                  <input
                    className="input mono"
                    value={draft.rpcid || ''}
                    onChange={(e) => setDraft({ ...draft, rpcid: e.target.value })}
                  />
                </div>
                <div className="field">
                  <div className="field-label">Captcha action (trống = không captcha)</div>
                  <input
                    className="input mono"
                    value={draft.captcha_action || ''}
                    onChange={(e) => setDraft({ ...draft, captcha_action: e.target.value })}
                  />
                </div>
                <div className="field">
                  <div className="field-label">Kết quả</div>
                  <select
                    className="input"
                    value={draft.result_kind || 'image'}
                    onChange={(e) => setDraft({ ...draft, result_kind: e.target.value as any })}
                  >
                    <option value="image">image</option>
                    <option value="video">video</option>
                    <option value="raw">raw</option>
                  </select>
                </div>
              </div>

              <div className="field">
                <div className="field-label">
                  <span>
                    Inner JSON — placeholder:{' '}
                    <span className="mono">
                      {'{{prompt}} {{project_id}} {{uuid}} {{seed}} {{media_N}} "__CAPTCHA__"'}
                    </span>
                  </span>
                </div>
                <textarea
                  className="input code"
                  rows={16}
                  value={innerJsonStr}
                  onChange={(e) => setInnerJsonStr(e.target.value)}
                />
              </div>

              <div className="actions">
                <button type="button" className="btn" onClick={handleSaveTemplate}>
                  Lưu
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={handleDeleteTemplate}
                >
                  Xoá
                </button>
              </div>

              <div className="section-title">Chạy template</div>
              {variables.map((name) => (
                <div key={name} className="field">
                  <div className="field-label">{name}</div>
                  {name === 'prompt' ? (
                    <textarea
                      className="input"
                      rows={2}
                      value={variablesValues[name] || ''}
                      onChange={(e) =>
                        setVariablesValues({ ...variablesValues, [name]: e.target.value })
                      }
                    />
                  ) : (
                    <input
                      className="input mono"
                      placeholder={name === 'seed' ? 'trống = ngẫu nhiên' : 'media id…'}
                      value={variablesValues[name] || ''}
                      onChange={(e) =>
                        setVariablesValues({ ...variablesValues, [name]: e.target.value })
                      }
                    />
                  )}
                </div>
              ))}

              <div className="actions">
                <button type="button" className="btn btn-primary" onClick={handleRunTemplate}>
                  Chạy
                </button>
                <button type="button" className="btn" onClick={handleRenderBody}>
                  Xem body
                </button>
              </div>

              {renderBodyOutput && <pre className="body">{renderBodyOutput}</pre>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

