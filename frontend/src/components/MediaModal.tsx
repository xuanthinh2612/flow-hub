import React, { useState, useEffect } from 'react';
import { MediaItem } from '../api/types';
import { api, mediaFile, withKey, invalidateMedia } from '../api/client';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { useMediaIn } from '../utils/storage';
import { useNavigate } from 'react-router-dom';

const USES = [
  { label: 'Tham chiếu cho Ảnh', page: 'image' as const, field: 'refs' },
  { label: 'Ảnh gốc để sửa', page: 'image' as const, field: 'base', multi: false, patch: { mode: 'edit' } },
  { label: 'Ảnh đầu (Ảnh → Video)', page: 'video' as const, field: 'starts', patch: { mode: 'i2v' } },
  { label: 'Ảnh đầu (đầu + cuối)', page: 'video' as const, field: 'start', multi: false, patch: { mode: 'first_last' } },
  { label: 'Ảnh cuối (đầu + cuối)', page: 'video' as const, field: 'end', multi: false, patch: { mode: 'first_last' } },
  { label: 'Ingredient (Omni)', page: 'video' as const, field: 'refs', patch: { mode: 'r2v' } },
];

export const MediaModalContent: React.FC<{ mediaId: string; onDeleted?: () => void }> = ({
  mediaId,
  onDeleted,
}) => {
  const [media, setMedia] = useState<MediaItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toast, copy } = useToast();
  const { closeModal } = useModal();
  const navigate = useNavigate();

  const load = async () => {
    try {
      setLoading(true);
      const m = await api<MediaItem>(`/api/media/${encodeURIComponent(mediaId)}`);
      setMedia(m);
      setError(null);
    } catch (e: any) {
      setError(e.message);
      toast(e.message, 'err');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [mediaId]);

  if (loading) return <p className="empty">Đang tải…</p>;
  if (error || !media) return <p className="err">{error || 'Không tìm thấy media'}</p>;

  const isVideo = media.kind === 'video';

  const handleUpscale = async (res: '2K' | '4K') => {
    try {
      const job = await api<{ id: string }>('/api/jobs', {
        method: 'POST',
        body: { type: 'upscale', media_id: media.id, resolution: res },
      });
      toast(`Đã gửi upscale ${res} (job ${job.id})`, 'ok');
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleRefresh = async () => {
    try {
      await api(`/api/media/${encodeURIComponent(media.id)}/refresh`, { method: 'POST' });
      toast('Đã làm mới URL', 'ok');
      load();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleDelete = async () => {
    try {
      await api(`/api/media/${encodeURIComponent(media.id)}`, { method: 'DELETE' });
      invalidateMedia();
      closeModal();
      toast('Đã xoá khỏi thư viện', 'ok');
      if (onDeleted) onDeleted();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  const handleUseIn = (u: (typeof USES)[0]) => {
    useMediaIn(u.page, u.field, media.id, { multi: u.multi !== false, patch: u.patch });
    closeModal();
    navigate(`/${u.page}`);
    toast(`Đã thêm vào: ${u.label}`, 'ok');
  };

  return (
    <div>
      {isVideo ? (
        <video className="media-view" src={mediaFile(media.id)} controls autoPlay={false} />
      ) : (
        <img className="media-view" src={mediaFile(media.id)} alt="" />
      )}

      <dl className="kv" style={{ marginTop: '10px' }}>
        <dt>Media ID</dt>
        <dd>{media.id}</dd>
        {media.source && (
          <>
            <dt>Nguồn</dt>
            <dd>{media.source}</dd>
          </>
        )}
        {media.model && (
          <>
            <dt>Model</dt>
            <dd>{media.model}</dd>
          </>
        )}
        {media.prompt && (
          <>
            <dt>Prompt</dt>
            <dd>{media.prompt}</dd>
          </>
        )}
        {media.aspect && (
          <>
            <dt>Tỉ lệ</dt>
            <dd>{media.aspect}</dd>
          </>
        )}
        {media.job_id && (
          <>
            <dt>Job</dt>
            <dd>{media.job_id}</dd>
          </>
        )}
        <dt>File trên server</dt>
        <dd>
          {media.local_path
            ? `${media.mime || ''} · ${Math.round((media.size || 0) / 1024)} KB`
            : 'chưa tải về'}
        </dd>
        {media.created_at && (
          <>
            <dt>Tạo lúc</dt>
            <dd>{new Date(media.created_at * 1000).toLocaleString('vi-VN')}</dd>
          </>
        )}
        {media.note && (
          <>
            <dt>Ghi chú</dt>
            <dd>{media.note}</dd>
          </>
        )}
      </dl>

      <div className="actions">
        <button type="button" className="btn btn-sm" onClick={() => copy(media.id, 'Đã copy media ID')}>
          Copy media ID
        </button>
        <a
          className="btn btn-sm"
          href={withKey(`/api/media/${encodeURIComponent(media.id)}/file?download=true`)}
          download=""
        >
          Tải xuống
        </a>
        <button type="button" className="btn btn-sm" onClick={handleRefresh}>
          Làm mới URL (as29s)
        </button>
        <button type="button" className="btn btn-sm btn-danger" onClick={handleDelete}>
          Xoá
        </button>
      </div>

      {!isVideo && (
        <>
          <div className="section-title">Dùng cho</div>
          <div className="actions">
            {USES.map((u, i) => (
              <button key={i} type="button" className="btn btn-sm" onClick={() => handleUseIn(u)}>
                {u.label}
              </button>
            ))}
          </div>

          <div className="section-title">Upscale (SPrCad)</div>
          <div className="actions">
            <button type="button" className="btn btn-sm" onClick={() => handleUpscale('2K')}>
              Upscale 2K
            </button>
            <button type="button" className="btn btn-sm" onClick={() => handleUpscale('4K')}>
              Upscale 4K
            </button>
          </div>
        </>
      )}
    </div>
  );
};

