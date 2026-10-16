import type { useGenerationStore } from "../../../store/generation.ts";
import type { RefSourceEntry } from "../types.ts";
import type { VideoUpstreamInfo } from "../../../utils/videoFrame.ts";

export type DispatchOpts = Parameters<ReturnType<typeof useGenerationStore.getState>["dispatchGeneration"]>[1];

export type VideoSubmitResult =
  | {
      ok: true;
      patchGeneration?: Record<string, unknown>;
      patchNodeData?: Record<string, unknown>;
      dispatch: DispatchOpts;
    }
  | { ok: false; nodeError: string };

export interface BuildVideoSubmitContext {
  prompt: string;
  aspectRatio: string;
  camera: "static" | "dynamic";
  variants: number;
  isOmniVideo: boolean;
  omniVideoMode: "default" | "video_reference";
  videoReferenceMediaId: string | null;
  videoInfo: VideoUpstreamInfo | null;
  r2vAdditionalMediaIds: string[];
  independentVideoMediaIds: string[];
  independentVideoMode: "i2v" | "r2v";
  hasPendingUpstream: boolean;
  isExtend: boolean;
  isEffectiveR2v: boolean;
  refSourceNodes: RefSourceEntry[];
  sourceMediaIds: string[];
  selectedSourceIdx: Set<number>;
  actualConnectedMode: string | undefined;
  connectedVideoMode: "i2v" | "r2v";
}

export function buildVideoSubmit(ctx: BuildVideoSubmitContext): VideoSubmitResult {
  const {
    prompt,
    aspectRatio,
    camera,
    variants,
    isOmniVideo,
    omniVideoMode,
    videoReferenceMediaId,
    videoInfo,
    r2vAdditionalMediaIds,
    independentVideoMediaIds,
    independentVideoMode,
    hasPendingUpstream,
    isExtend,
    isEffectiveR2v,
    refSourceNodes,
    sourceMediaIds,
    selectedSourceIdx,
    actualConnectedMode,
    connectedVideoMode,
  } = ctx;

  // 0. Video Reference (Omni Flash abra_edit - jIps6)
  if (!isEffectiveR2v && isOmniVideo && omniVideoMode === "video_reference") {
    const refMid = videoReferenceMediaId || videoInfo?.sourceMediaId || null;
    if (!refMid && !hasPendingUpstream) return { ok: false, nodeError: "Vui lòng chọn hoặc tải lên video tham chiếu." };

    const upstreamImageIds = refSourceNodes
      .filter((r) => r.node.data.type !== "video" && Boolean(r.mediaId))
      .map((r) => r.mediaId as string);
    const combinedMediaIds = Array.from(new Set([...upstreamImageIds, ...r2vAdditionalMediaIds]));

    return {
      ok: true,
      patchGeneration: {
        videoMode: "video_reference",
        videoReference: { sourceMediaId: refMid ?? undefined },
        r2vAdditionalMediaIds,
      },
      patchNodeData: { extractingFrame: false, extractError: null },
      dispatch: {
        prompt,
        aspectRatio,
        kind: "video",
        cameraMode: camera,
        videoMode: "video_reference",
        sourceMediaId: refMid ?? undefined,
        sourceMediaIds: combinedMediaIds.length > 0 ? combinedMediaIds : undefined,
        variantCount: variants,
      },
    };
  }

  // 1. Text-to-Video (không có node nào trước) / Independent Video
  if (videoInfo?.mode === "t2v") {
    const actualMode = independentVideoMediaIds.length > 1
      ? "r2v"
      : independentVideoMediaIds.length === 1
        ? independentVideoMode
        : "t2v";
    return {
      ok: true,
      patchGeneration: { independentVideoMediaIds, independentVideoMode, videoMode: actualMode },
      dispatch: {
        prompt,
        aspectRatio,
        kind: "video",
        cameraMode: camera,
        videoMode: actualMode,
        sourceMediaIds: independentVideoMediaIds.length > 0 ? independentVideoMediaIds : undefined,
        variantCount: variants,
      },
    };
  }

  // 2. Nối tiếp video hoặc Extend video
  if (videoInfo?.mode === "video_continuation" && !isEffectiveR2v) {
    if (!videoInfo.sourceMediaId && !hasPendingUpstream) {
      return {
        ok: false,
        nodeError: isExtend
          ? "Video trước chưa có file để kéo dài."
          : "Video trước chưa có file để trích xuất frame cuối.",
      };
    }
    return {
      ok: true,
      patchNodeData: { extractingFrame: false, extractError: null },
      dispatch: isExtend
        ? {
            prompt,
            aspectRatio,
            kind: "video",
            cameraMode: camera,
            videoMode: "extend_video",
            sourceMediaId: videoInfo.sourceMediaId,
            variantCount: variants,
          }
        : {
            prompt,
            aspectRatio,
            kind: "video",
            cameraMode: camera,
            videoMode: "i2v",
            sourceVideoId: videoInfo.sourceMediaId,
            variantCount: 1,
          },
    };
  }

  // 3. Ảnh -> Video (i2v hoặc r2v)
  if (isEffectiveR2v) {
    const sources = refSourceNodes.flatMap((r) => r.mediaId
      ? [{ mediaId: r.mediaId, isVideo: r.node.data.type === "video" }]
      : []);
    const r2vSourceMediaIds = [
      ...sources.filter((source) => !source.isVideo).map((source) => source.mediaId),
      ...r2vAdditionalMediaIds,
    ];
    const sourceVideoIds = sources.filter((source) => source.isVideo).map((source) => source.mediaId);
    return {
      ok: true,
      patchGeneration: { r2vAdditionalMediaIds, connectedVideoMode },
      patchNodeData: { extractingFrame: false, extractError: null },
      dispatch: {
        prompt,
        aspectRatio,
        kind: "video",
        cameraMode: camera,
        videoMode: "r2v",
        sourceMediaIds: r2vSourceMediaIds,
        sourceVideoIds,
        variantCount: variants,
      },
    };
  }

  const finalPicked = sourceMediaIds.filter((_, i) => selectedSourceIdx.has(i));
  const useMulti = finalPicked.length > 1;
  return {
    ok: true,
    patchGeneration: videoInfo?.mode === "i2v" ? { connectedVideoMode } : undefined,
    dispatch: {
      prompt,
      aspectRatio,
      kind: "video",
      cameraMode: camera,
      videoMode: actualConnectedMode as "i2v" | "r2v",
      sourceMediaId: useMulti ? undefined : finalPicked[0],
      sourceMediaIds: useMulti ? finalPicked : undefined,
      variantCount: actualConnectedMode === "r2v" ? variants : (useMulti ? finalPicked.length * variants : variants),
    },
  };
}
