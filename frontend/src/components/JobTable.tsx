import React from 'react';
import { JobItem } from '../api/types';
import { ago, typeLabel, STATUS_LABEL } from '../utils/format';
import { mediaFile } from '../api/client';
import { useModal } from '../context/ModalContext';
import { JobModalContent } from './JobModal';
import { MediaVisual } from './MediaVisual';

interface JobTableProps {
  jobs: JobItem[];
  onRefresh?: () => void;
}

export const JobTable: React.FC<JobTableProps> = ({ jobs, onRefresh }) => {
  const { openModal } = useModal();

  if (!jobs.length) {
    return <p className="empty">Chưa có job nào.</p>;
  }

  const handleOpenJob = (j: JobItem) => {
    openModal(`${typeLabel(j.type)} · ${j.id}`, <JobModalContent jobId={j.id} onDeleted={onRefresh} />);
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="list">
        <thead>
          <tr>
            <th>Thời gian</th>
            <th>Loại</th>
            <th>Model</th>
            <th>Prompt</th>
            <th>Trạng thái</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className="click" onClick={() => handleOpenJob(j)}>
              <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                {ago(j.created_at)}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>{typeLabel(j.type)}</td>
              <td className="mono" style={{ maxWidth: '130px', wordBreak: 'break-all' }}>
                {j.model || ''}
              </td>
              <td style={{ maxWidth: '160px' }}>
                <div className="clamp">{j.prompt || ''}</div>
              </td>
              <td>
                <span className={`status ${j.status}`}>{STATUS_LABEL[j.status] || j.status}</span>
                {j.error && (
                  <div className="err clamp" style={{ fontSize: '12px' }}>
                    {j.error}
                  </div>
                )}
              </td>
              <td>
                <div className="picker">
                  {(j.results || [])
                    .filter((r) => r.media_id)
                    .map((r) => (
                      <div key={r.media_id} className="pick" title={r.media_id}>
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

