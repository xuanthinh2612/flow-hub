import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, invalidateMedia, projectMediaZipUrl } from '../api/client';
import { MediaItem } from '../api/types';
import { ago } from '../utils/format';
import { MediaVisual } from '../components/MediaVisual';
import { MediaModalContent } from '../components/MediaModal';
import { useModal } from '../context/ModalContext';
import { useToast } from '../context/ToastContext';
import { useFlowEvents } from '../api/events';
import { useLocation } from 'react-router-dom';

interface FilterOption {
  label: string;
  kind?: string;
  source?: string;
}

const FILTERS: FilterOption[] = [
  { label: 'Tất cả' },
  { label: 'Ảnh', kind: 'image' },
  { label: 'Video', kind: 'video' },
  { label: 'Nhân vật', source: 'character' },
  { label: 'Upload', source: 'upload' },
  { label: 'Upscale', source: 'upscale' },
];

export const LibraryPage: React.FC = () => {
  const [mediaList, setMediaList] = useState<MediaItem[]>([]);
  const [activeFilterIndex, setActiveFilterIndex] = useState<number>(0);
  const [idInput, setIdInput] = useState('');
  const [loading, setLoading] = useState(true);
  const location = useLocation();
  const workspaceId = (() => {
    const fromUrl = new URLSearchParams(location.search).get('workspace_id');
    if (fromUrl) return fromUrl;
    try {
      return localStorage.getItem('flowboard.activeProjectId');
    } catch { return null; }
  })();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { openModal } = useModal();
  const { toast } = useToast();

  const load = useCallback(async () => {
    const f = FILTERS[activeFilterIndex];
    const q = new URLSearchParams({ limit: '500' });
    if (workspaceId !== null) q.set('workspace_id', String(workspaceId));
    if (f.kind) q.set('kind', f.kind);
    if (f.source) q.set('source', f.source);

    try {
      const items = await api<MediaItem[]>(`/api/media?${q}`);
      setMediaList(items || []);
    } catch {
      setMediaList([]);
    } finally {
      setLoading(false);
    }
  }, [activeFilterIndex, workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  useFlowEvents((evt) => {
    if (evt.type === 'media') {
      load();
    }
  }, [load]);

  const handleOpenMedia = (mediaId: string) => {
    openModal('Media', <MediaModalContent mediaId={mediaId} onDeleted={load} />);
  };

  const handleUploadFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (!files.length) return;

    for (const f of files) {
      const form = new FormData();
      form.append('file', f);
      if (workspaceId !== null) form.append('workspace_id', String(workspaceId));
      try {
        const job = await api<{ id: string }>('/api/uploads', { method: 'POST', form });
        toast(`Đang upload ${f.name} (job ${job.id})`, 'ok');
      } catch (err: any) {
        toast(`${f.name}: ${err.message}`, 'err');
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleAddById = async () => {
    const trimmed = idInput.trim();
    if (!trimmed) return;
    try {
      await api('/api/media', { method: 'POST', body: { media_id: trimmed, workspace_id: workspaceId } });
      setIdInput('');
      toast('Đã thêm', 'ok');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm('Xóa tất cả media trong thư viện?')) return;
    try {
      const scope = workspaceId === null ? '' : `?workspace_id=${workspaceId}`;
      await api(`/api/media${scope}`, { method: 'DELETE' });
      invalidateMedia();
      toast('Đã xóa media trong project', 'ok');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Thư viện</h1>
          <p>
            {workspaceId === null ? 'Mọi ảnh / video chưa gắn với một canvas project.' : 'Ảnh và video trong project hiện tại. Bấm vào để xem, tải, upscale hoặc dùng'}
            {workspaceId !== null && ' làm tham chiếu.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {workspaceId !== null && (
            <a className="btn btn-sm" href={projectMediaZipUrl(String(workspaceId))}>
              Tải toàn bộ project (.zip)
            </a>
          )}
          <button type="button" className="btn btn-sm btn-danger" onClick={handleClearAll}>
            Xóa toàn bộ
          </button>
        </div>
      </div>

      <div className="card">
        <div className="inline">
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            Tải ảnh lên Flow
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              hidden
              onChange={handleUploadFiles}
            />
          </label>
          <input
            className="input mono"
            placeholder="media ID có sẵn trong project Flow"
            spellCheck={false}
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddById();
            }}
          />
          <button type="button" className="btn" onClick={handleAddById}>
            Thêm theo ID
          </button>
        </div>
      </div>

      <div style={{ height: '12px' }} />

      <div className="seg">
        {FILTERS.map((f, i) => (
          <button
            key={f.label}
            type="button"
            className={`chip${i === activeFilterIndex ? ' active' : ''}`}
            onClick={() => setActiveFilterIndex(i)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && !mediaList.length ? (
        <p className="empty">Đang tải…</p>
      ) : (
        <div className="tiles">
          {mediaList.map((m) => (
            <div
              key={m.id}
              className="tile"
              title={m.prompt || m.id}
              onClick={() => handleOpenMedia(m.id)}
            >
              <MediaVisual media={m} />
              {m.kind === 'video' && <span className="badge-v">▶ video</span>}
              <div className="meta">
                <span>{m.source || ''}</span>
                <span>{ago(m.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && !mediaList.length && <p className="empty">Chưa có media nào.</p>}
    </div>
  );
};

