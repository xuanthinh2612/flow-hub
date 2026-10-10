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

export type VideoModeType = 't2v' | 'i2v' | 'video_continuation' | 'r2v';

export interface VideoUpstreamInfo {
  mode: VideoModeType;
  label: string;
  sourceNode?: FlowNode;
  sourceMediaId?: string;
  sourceMediaIds?: string[];
  isVideoUpstream: boolean;
  isImageUpstream: boolean;
  upstreamNodes: FlowNode[];
}

export function getVideoUpstreamInfo(
  rfId: string,
  nodes: FlowNode[],
  edges: Edge[]
): VideoUpstreamInfo {
  const incomingEdges = edges.filter((e) => e.target === rfId);
  const upstreamNodes = incomingEdges
    .map((e) => nodes.find((n) => n.id === e.source))
    .filter((n): n is FlowNode => Boolean(n) && ['image', 'character', 'visual_asset', 'Storyboard', 'video'].includes(n!.data.type));

  if (upstreamNodes.length >= 2) {
    return {
      mode: 'r2v',
      label: 'Ingredients (r2v)',
      upstreamNodes,
      isVideoUpstream: upstreamNodes.some((n) => n.data.type === 'video'),
      isImageUpstream: upstreamNodes.some((n) => n.data.type !== 'video'),
    };
  }

  if (upstreamNodes.length === 1) {
    const sourceNode = upstreamNodes[0];
    const isVideo = sourceNode.data.type === 'video';
    const edge = incomingEdges.find((e) => e.source === sourceNode.id);
    const pin = (edge?.data?.sourceVariantIdx ?? null) as number | null;
    const variants = (Array.isArray(sourceNode.data.mediaIds) ? sourceNode.data.mediaIds : []).filter(
      (m): m is string => typeof m === 'string' && m.length > 0
    );
    let sourceMediaId: string | undefined;
    if (pin !== null && pin >= 0 && pin < variants.length) {
      sourceMediaId = variants[pin];
    } else if (typeof sourceNode.data.mediaId === 'string' && sourceNode.data.mediaId) {
      sourceMediaId = sourceNode.data.mediaId;
    } else if (variants.length > 0) {
      sourceMediaId = variants[0];
    }
    const denseMids = variants.length > 0 ? variants : (sourceMediaId ? [sourceMediaId] : []);

    return {
      mode: 'i2v',
      label: isVideo ? 'Nối tiếp video (i2v)' : 'Ảnh → Video (i2v)',
      sourceNode,
      sourceMediaId,
      sourceMediaIds: denseMids,
      isVideoUpstream: isVideo,
      isImageUpstream: !isVideo,
      upstreamNodes,
    };
  }

  return {
    mode: 't2v',
    label: 'Text → Video (t2v)',
    isVideoUpstream: false,
    isImageUpstream: false,
    upstreamNodes: [],
  };
}

