import React, { useState } from 'react';
import { MediaItem } from '../api/types';
import { mediaFile, withKey } from '../api/client';

interface MediaVisualProps {
  media?:
    | MediaItem
    | {
        id: string;
        kind?: string;
        poster_url?: string | null;
        local_path?: string;
        url?: string;
      }
    | null;
  className?: string;
  fallbackText?: string;
}

export const MediaVisual: React.FC<MediaVisualProps> = ({ media, className = '', fallbackText }) => {
  const [posterError, setPosterError] = useState(false);
  const [imgError, setImgError] = useState(false);

  if (!media || !media.id) {
    return <div className={`noimg ${className}`}>{fallbackText || '?'}</div>;
  }

  const isVideo = media.kind === 'video';

  if (isVideo) {
    // If poster_url is provided and has not failed, try loading it
    if (media.poster_url && !posterError) {
      const src = withKey(`/api/media/${encodeURIComponent(media.id)}/poster`);
      return (
        <img
          src={src}
          loading="lazy"
          alt=""
          className={className}
          onError={() => setPosterError(true)}
        />
      );
    }

    // Fallback: load the first frame directly from the video file on server
    return (
      <video
        src={`${mediaFile(media.id)}#t=0.001`}
        muted
        preload="metadata"
        playsInline
        className={className}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    );
  }

  // It's an image: load via /api/media/{id}/file
  if (imgError) {
    return <div className={`noimg ${className}`}>{media.id}</div>;
  }

  return (
    <img
      src={mediaFile(media.id)}
      loading="lazy"
      alt=""
      className={className}
      onError={() => setImgError(true)}
    />
  );
};
