import { uploadImage } from '../canvas/dummyApi';
import { mediaFile } from '../api/client';
import type { FlowNode } from '../store/board';
import type { Edge } from '@xyflow/react';

/**
 * Extracts the last frame of a video by seeking near the end of the video
 * and drawing the frame to an off-screen HTML5 canvas.
 */
export async function extractVideoLastFrame(videoSrc: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;

    let timeoutId: any = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout khi tải video để trích xuất frame cuối (15s)'));
    }, 15000);

    video.onloadedmetadata = () => {
      // Seek to 0.08s before duration to capture the final stable frame
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
      const targetTime = Math.max(0, duration - 0.08);
      if (targetTime === 0 && video.currentTime === 0) {
        video.currentTime = 0.001;
      } else {
        video.currentTime = targetTime;
      }
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cleanup();
          reject(new Error('Không thể tạo 2D context cho canvas'));
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            cleanup();
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Không thể tạo file ảnh từ frame video'));
            }
          },
          'image/jpeg',
          0.95
        );
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    video.onerror = () => {
      cleanup();
      reject(new Error('Lỗi khi tải video để trích xuất frame cuối. Vui lòng kiểm tra lại URL video.'));
    };

    video.src = videoSrc;
  });
}

/**
 * Extracts the last frame of a given video mediaId and uploads it as an image
 * to flow-hub, returning the new media_id.
 */
export async function extractAndUploadLastFrame(videoMediaId: string): Promise<string> {
  const videoUrl = mediaFile(videoMediaId);
  const blob = await extractVideoLastFrame(videoUrl);
  const file = new File([blob], `last_frame_${videoMediaId.slice(0, 8)}_${Date.now()}.jpg`, {
    type: 'image/jpeg',
  });
  const uploaded = await uploadImage(file);
  return uploaded.media_id;
}

export type VideoModeType = 't2v' | 'i2v' | 'video_continuation';

export interface VideoUpstreamInfo {
  mode: VideoModeType;
  label: string;
  sourceNode?: FlowNode;
  sourceMediaId?: string;
  sourceMediaIds?: string[];
  isVideoUpstream: boolean;
  isImageUpstream: boolean;
}

export function getVideoUpstreamInfo(
  rfId: string,
  nodes: FlowNode[],
  edges: Edge[]
): VideoUpstreamInfo {
  const incomingEdges = edges.filter((e) => e.target === rfId);
  const upstreamNodes = incomingEdges
    .map((e) => nodes.find((n) => n.id === e.source))
    .filter((n): n is FlowNode => Boolean(n));

  // 1. Check if there is an upstream video
  const videoUpstream = upstreamNodes.find((n) => n.data.type === 'video');
  if (videoUpstream) {
    const vEdge = incomingEdges.find((e) => e.source === videoUpstream.id);
    const pin = (vEdge?.data?.sourceVariantIdx ?? null) as number | null;
    const vVariants = (Array.isArray(videoUpstream.data.mediaIds) ? videoUpstream.data.mediaIds : []).filter(
      (m): m is string => typeof m === 'string' && m.length > 0
    );
    let sourceMediaId: string | undefined;
    if (pin !== null && pin >= 0 && pin < vVariants.length) {
      sourceMediaId = vVariants[pin];
    } else if (typeof videoUpstream.data.mediaId === 'string' && videoUpstream.data.mediaId) {
      sourceMediaId = videoUpstream.data.mediaId;
    } else if (vVariants.length > 0) {
      sourceMediaId = vVariants[0];
    }

    return {
      mode: 'video_continuation',
      label: 'Nối tiếp video (frame cuối)',
      sourceNode: videoUpstream,
      sourceMediaId,
      sourceMediaIds: vVariants,
      isVideoUpstream: true,
      isImageUpstream: false,
    };
  }

  // 2. Check if there is an upstream image (image, character, visual_asset, Storyboard)
  const imageUpstream = upstreamNodes.find((n) =>
    ['image', 'character', 'visual_asset', 'Storyboard'].includes(n.data.type)
  );
  if (imageUpstream) {
    const iEdge = incomingEdges.find((e) => e.source === imageUpstream.id);
    const pin = (iEdge?.data?.sourceVariantIdx ?? null) as number | null;
    const iVariants = (Array.isArray(imageUpstream.data.mediaIds) ? imageUpstream.data.mediaIds : []).filter(
      (m): m is string => typeof m === 'string' && m.length > 0
    );
    let sourceMediaId: string | undefined;
    if (pin !== null && pin >= 0 && pin < iVariants.length) {
      sourceMediaId = iVariants[pin];
    } else if (typeof imageUpstream.data.mediaId === 'string' && imageUpstream.data.mediaId) {
      sourceMediaId = imageUpstream.data.mediaId;
    } else if (iVariants.length > 0) {
      sourceMediaId = iVariants[0];
    }
    const denseMids = iVariants.length > 0 ? iVariants : (sourceMediaId ? [sourceMediaId] : []);

    return {
      mode: 'i2v',
      label: 'Ảnh → Video (i2v)',
      sourceNode: imageUpstream,
      sourceMediaId,
      sourceMediaIds: denseMids,
      isVideoUpstream: false,
      isImageUpstream: true,
    };
  }

  // 3. No preceding video or image/character -> Text to Video
  return {
    mode: 't2v',
    label: 'Text → Video (t2v)',
    isVideoUpstream: false,
    isImageUpstream: false,
  };
}

