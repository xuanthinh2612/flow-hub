import type { FlowNode } from '../store/board';
import type { Edge } from '@xyflow/react';

export type VideoModeType = 't2v' | 'i2v' | 'video_continuation' | 'extend_video' | 'r2v';

export interface VideoUpstreamInfo {
  mode: VideoModeType;
  label: string;
  sourceNode?: FlowNode;
  sourceMediaId?: string;
  sourceMediaIds?: string[];
  isVideoUpstream: boolean;
  isImageUpstream: boolean;
  upstreamNodes: FlowNode[];
  /** Family of the single upstream video node (if mode is video_continuation).
   *  Derived from node.data.generation?.model?.family. */
  sourceNodeFamily?: string | undefined;
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
    // Detect the family of the upstream video so the dialog can offer
    // extend_video (Veo-only) vs video_continuation (model-agnostic).
    const gen = sourceNode.data.generation as any;
    const rawFamily = gen?.model?.family ?? gen?.videoModel;
    const modelId = typeof gen?.model?.id === 'string' ? gen.model.id : '';
    // A default Veo preference is stored on every newly created video node,
    // including nodes that later receive an uploaded clip. Generated nodes
    // carry a request id; older Veo nodes may lack the completion quality
    // stamp, so accept either generation marker while excluding uploads.
    const isVeoModel = rawFamily === 'veo'
      || modelId.startsWith('veo_')
      || gen?.videoMode === 'extend_video';
    const isOmniModel = rawFamily === 'omni_flash'
      || modelId.startsWith('abra_')
      || gen?.videoMode === 'video_reference';
    const generatedVideoModel = (sourceNode.data as any)?.videoQuality ?? gen?.model?.quality;
    const hasGenerationMarker = (typeof generatedVideoModel === 'string'
        && generatedVideoModel.length > 0
        && !generatedVideoModel.startsWith('abra_'))
      || (typeof sourceNode.data.lastRequestId === 'string' && sourceNode.data.lastRequestId.length > 0)
      || sourceNode.data.status === 'queued'
      || sourceNode.data.status === 'running';
    const sourceNodeFamily: string | undefined = isVideo
      ? isOmniModel
        ? 'omni_flash'
        : hasGenerationMarker && isVeoModel
          ? 'veo'
          : undefined
      : undefined;

    return {
      mode: isVideo ? 'video_continuation' : 'i2v',
      label: isVideo ? 'Nối tiếp video (i2v)' : 'Ảnh → Video (i2v)',
      sourceNode,
      sourceMediaId,
      sourceMediaIds: denseMids,
      isVideoUpstream: isVideo,
      isImageUpstream: !isVideo,
      upstreamNodes,
      sourceNodeFamily,
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


