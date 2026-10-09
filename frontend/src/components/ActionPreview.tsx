import React, { useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/ToastContext';
import { fmt } from '../utils/format';

interface ActionPreviewProps {
  label: string;
  getSpec: () => any;
  onJobSubmitted?: () => void;
}

export const ActionPreview: React.FC<ActionPreviewProps> = ({
  label,
  getSpec,
  onJobSubmitted,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const spec = getSpec();
      const job = await api<{ id: string }>('/api/jobs', { method: 'POST', body: spec });
      toast(`Đã gửi job ${job.id} — theo dõi ở cột bên phải`, 'ok');
      if (onJobSubmitted) onJobSubmitted();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setTimeout(() => setSubmitting(false), 700);
    }
  };

  const handleTogglePreview = async () => {
    if (showPreview) {
      setShowPreview(false);
      return;
    }
    try {
      const spec = getSpec();
      const calls = await api<any[]>('/api/jobs/preview', { method: 'POST', body: spec });
      const text = calls
        .map(
          (c, i) =>
            `── request ${i + 1}/${calls.length} · ${c.label} · ${c.rpcid} · captcha ${
              c.captcha_action || '—'
            } · model ${c.model || '—'}${c.model_status ? ` (${c.model_status})` : ''} ──\n` +
            `POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=${c.rpcid}&…\n` +
            `f.req = [[["${c.rpcid}", JSON.stringify(inner), null, "generic"]]]   ·   "__CAPTCHA__" được thay bằng token mới\ninner =\n${fmt(
              c.inner
            )}`
        )
        .join('\n\n');
      setPreviewContent(text);
      setShowPreview(true);
    } catch (e: any) {
      setPreviewContent(`⚠ ${e.message}`);
      setShowPreview(true);
    }
  };

  return (
    <div>
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={submitting}
          onClick={handleSubmit}
        >
          {label}
        </button>
        <button type="button" className="btn" onClick={handleTogglePreview}>
          Xem body
        </button>
      </div>
      {showPreview && previewContent && <pre className="body">{previewContent}</pre>}
    </div>
  );
};

