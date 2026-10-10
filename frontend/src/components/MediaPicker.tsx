import React, { useState, useEffect } from 'react';
import { MediaItem } from '../api/types';
import { allMedia } from '../api/client';
import { MediaVisual } from './MediaVisual';
import { useModal } from '../context/ModalContext';
import { ago } from '../utils/format';

interface MediaPickerProps {
  value: string | string[] | null;
  multi?: boolean;
  onChange: (value: any, items?: MediaItem[]) => void;
  kind?: 'image' | 'video' | 'both';
  disabled?: boolean;
}

export const MediaPicker: React.FC<MediaPickerProps> = ({ value, multi = false, onChange, kind = 'image', disabled = false }) => {
  const { openModal, closeModal } = useModal();
  const [mediaMap, setMediaMap] = useState<Record<string, MediaItem>>({});

  const ids: string[] = Array.isArray(value) ? value : value ? [value] : [];

  useEffect(() => {
    let active = true;
    allMedia().then((list) => {
      if (!active) return;
      const map: Record<string, MediaItem> = {};
      for (const m of list) map[m.id] = m;
      setMediaMap(map);
    });
    return () => {
      active = false;
    };
  }, [value]);

  const emit = (newIds: string[]) => {
    const items = newIds.map(id => mediaMap[id]).filter(Boolean);
    onChange(multi ? newIds : newIds[0] || null, items);
  };

  const handleRemove = (idToRemove: string) => {
    const next = ids.filter((id) => id !== idToRemove);
    emit(next);
  };

  const openPickerModal = async () => {
    const list = (await allMedia()).filter((m) => kind === 'both' || m.kind === kind);
    let title = 'Chọn ảnh';
    if (kind === 'video') title = 'Chọn video';
    if (kind === 'both') title = 'Chọn ảnh / video';
    if (multi) title += ' (nhiều)';
    
    openModal(
      title,
      <PickerModalContent
        initialSelected={ids}
        mediaList={list}
        multi={multi}
        onConfirm={(chosen) => {
          // fetch from updated list if missing in map
          const newMap = { ...mediaMap };
          list.forEach(m => newMap[m.id] = m);
          setMediaMap(newMap);
          
          const items = chosen.map(id => newMap[id]).filter(Boolean);
          onChange(multi ? chosen : chosen[0] || null, items);
          closeModal();
        }}
      />
    );
  };

  return (
    <div className="picker">
      {ids.map((id) => (
        <div key={id} className="pick" title={id}>
          {mediaMap[id] ? (
            <MediaVisual media={mediaMap[id]} />
          ) : (
            <div className="noimg">{id.slice(0, 22)}</div>
          )}
          <button type="button" className="x" onClick={() => handleRemove(id)} disabled={disabled}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="pick-add" onClick={openPickerModal} disabled={disabled}>
        {ids.length && !multi ? 'Đổi' : '+ Chọn'}
      </button>
    </div>
  );
};

interface PickerModalContentProps {
  initialSelected: string[];
  mediaList: MediaItem[];
  multi: boolean;
  onConfirm: (selected: string[]) => void;
}

const PickerModalContent: React.FC<PickerModalContentProps> = ({
  initialSelected,
  mediaList,
  multi,
  onConfirm,
}) => {
  const [selected, setSelected] = useState<string[]>([...initialSelected]);
  const [pasteId, setPasteId] = useState('');

  const handleToggle = (id: string) => {
    if (multi) {
      setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    } else {
      setSelected((prev) => (prev[0] === id ? [] : [id]));
    }
  };

  const handleAddCustomId = () => {
    const trimmed = pasteId.trim();
    if (!trimmed) return;
    if (multi) {
      setSelected((prev) => [...new Set([...prev, trimmed])]);
    } else {
      setSelected([trimmed]);
    }
    setPasteId('');
  };

  return (
    <div>
      <div className="inline" style={{ marginBottom: '10px' }}>
        <input
          className="input mono"
          placeholder="…hoặc dán media ID"
          spellCheck={false}
          value={pasteId}
          onChange={(e) => setPasteId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddCustomId();
          }}
        />
        <button type="button" className="btn btn-sm" onClick={handleAddCustomId}>
          Thêm ID
        </button>
      </div>

      <div className="tiles">
        {mediaList.map((m) => {
          const isSelected = selected.includes(m.id);
          return (
            <div
              key={m.id}
              className={`tile${isSelected ? ' selected' : ''}`}
              title={m.prompt || m.id}
              onClick={() => handleToggle(m.id)}
            >
              <MediaVisual media={m} />
              <div className="meta">
                <span>{m.source || ''}</span>
                <span>{ago(m.created_at)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {!mediaList.length && (
        <p className="empty">Thư viện chưa có ảnh — tạo hoặc tải ảnh lên trước.</p>
      )}

      <div className="actions" style={{ marginTop: '14px', alignItems: 'center' }}>
        <span className="muted">{selected.length} đã chọn</span>
        <button type="button" className="btn btn-primary" onClick={() => onConfirm(selected)}>
          Xong
        </button>
      </div>
    </div>
  );
};

