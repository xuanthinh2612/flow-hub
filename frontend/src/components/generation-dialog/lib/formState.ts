import type { Edge } from "@xyflow/react";
import type { MediaItem } from "../../../api/types";
import type { CountryKey, GenderKey, VibeKey } from "../../../constants/character";
import {
  buildStoryboardVideoPrompt,
  normaliseStoryboardGrid,
} from "../../../lib/storyboardPrompt.ts";
import type { FlowNode, NodeGeneration } from "../../../store/board";
import type {
  ImageModelKey,
  MediaProviderKey,
  OmniFlashDuration,
  OmniFlashResolution,
  VideoModelFamily,
  VideoQuality,
} from "../../../store/settings";
import { getVideoUpstreamInfo, type VideoModeType } from "../../../utils/videoFrame.ts";
import type { AspectKey, ImageAspectKey, VideoAspectKey } from "../constants";
import { IMAGE_ASPECT_RATIOS, VIDEO_ASPECT_RATIOS } from "../constants.ts";
import type { GenerationFormState } from "../types";
import { buildCharacterPrompt } from "./characterPrompt.ts";
import { pickDefaultAspect } from "./aspect.ts";

export interface FormDefaults {
  videoModel: VideoModelFamily;
  videoQuality: VideoQuality;
  imageModel: ImageModelKey;
  omniFlashDuration: OmniFlashDuration;
  omniFlashResolution: OmniFlashResolution;
  mediaProvider: MediaProviderKey;
}

export interface FormSnapshot {
  rfId: string;
  nodes: FlowNode[];
  edges: Edge[];
  defaults: FormDefaults;
  seedPrompt: string;
  boardPublicId: string | null;
}

function isImageAspect(value: unknown): value is ImageAspectKey {
  return typeof value === "string" &&
    IMAGE_ASPECT_RATIOS.some((aspect) => aspect.key === value);
}

function isVideoAspect(value: unknown): value is VideoAspectKey {
  return typeof value === "string" &&
    VIDEO_ASPECT_RATIOS.some((aspect) => aspect.key === value);
}

function resolveAspect(
  savedAspect: unknown,
  inheritedAspect: string | null,
  nodeType: string,
): AspectKey {
  if (isImageAspect(savedAspect) || isVideoAspect(savedAspect)) return savedAspect;
  if (isImageAspect(inheritedAspect) || isVideoAspect(inheritedAspect)) {
    return inheritedAspect;
  }
  return nodeType === "video"
    ? "VIDEO_ASPECT_RATIO_LANDSCAPE"
    : "IMAGE_ASPECT_RATIO_LANDSCAPE";
}

function resolveSelectedSourceIdx(
  savedSelection: unknown,
  sourceMediaIds: string[],
): number[] | null {
  if (!Array.isArray(savedSelection)) return null;
  return savedSelection.filter(
    (index): index is number =>
      typeof index === "number" &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < sourceMediaIds.length,
  );
}

export function hydrateForm(snapshot: FormSnapshot): GenerationFormState {
  const {
    rfId,
    nodes,
    edges,
    defaults,
    seedPrompt,
  } = snapshot;
  const node = nodes.find((item) => item.id === rfId);
  const nodeType = node?.data.type ?? "image";
  const savedGeneration = (node?.data.generation ?? {}) as NodeGeneration;
  const savedForm = savedGeneration as Partial<GenerationFormState>;
  const backend = savedForm.backend ?? defaults.mediaProvider;
  const storedVideoModelFamily = savedGeneration.model?.family;
  const imageModel = savedGeneration.model?.family === "image" ? savedGeneration.model.id : undefined;
  const duration = savedGeneration.duration;
  const resolution = savedGeneration.resolution;

  let initialPrompt = seedPrompt;
  if (nodeType === "video") {
    const storyboard = edges
      .filter((edge) => edge.target === rfId)
      .map((edge) => nodes.find((item) => item.id === edge.source))
      .find((item) => item?.data.type === "Storyboard");
    if (storyboard) {
      initialPrompt = buildStoryboardVideoPrompt(
        normaliseStoryboardGrid(storyboard.data.generation?.storyboardGrid),
      );
    }
  }
  const prompt = typeof savedForm.prompt === "string"
    ? savedForm.prompt
    : initialPrompt;

  const inheritedAspect = pickDefaultAspect(rfId, nodeType, nodes, edges);
  const aspectRatio = nodeType === "character"
    ? "IMAGE_ASPECT_RATIO_SQUARE"
    : resolveAspect(savedForm.aspectRatio, inheritedAspect, nodeType);

  const charGender = savedForm.charGender ?? node?.data.generation?.charGender as GenderKey ?? null;
  const charCountry = savedForm.charCountry ?? node?.data.generation?.charCountry as CountryKey ?? null;
  const charVibe = savedForm.charVibe ?? node?.data.generation?.charVibe as VibeKey ?? "clean";
  const charExtras = savedForm.charExtras ?? node?.data.generation?.charExtras as string ?? "";
  const hydratedPrompt = nodeType === "character" && !initialPrompt && typeof savedForm.prompt !== "string"
    ? buildCharacterPrompt(charGender, charCountry, charVibe, charExtras)
    : prompt;

  const videoInfo = nodeType === "video"
    ? getVideoUpstreamInfo(rfId, nodes, edges)
    : null;
  const isMultiSource = videoInfo?.mode === "r2v" || (videoInfo?.upstreamNodes?.length ?? 0) >= 2;
  const isSavedVideoReference = !isMultiSource && (
    savedGeneration.videoMode === "video_reference"
    || savedForm.omniVideoMode === "video_reference"
  );
  const videoModel = isSavedVideoReference
    ? "omni_flash"
    : (isMultiSource && (savedGeneration.videoMode === "video_reference" || savedForm.omniVideoMode === "video_reference")
      ? defaults.videoModel
      : storedVideoModelFamily);
  const connectedVideoMode = isMultiSource
    ? "r2v"
    : (savedForm.connectedVideoMode ?? (savedGeneration.videoMode === "r2v" ? "r2v" : "i2v"));
  const videoQuality: VideoQuality = savedGeneration.model?.quality === "fast" || savedGeneration.model?.quality === "lite" ||
    savedGeneration.model?.quality === "quality" || savedGeneration.model?.quality === "lite_relaxed" ||
    savedGeneration.model?.quality === "fast_ultra" || savedGeneration.model?.quality === "lite_low_priority"
    ? savedGeneration.model.quality
    : defaults.videoQuality;
  const sourceMediaIds = videoInfo?.sourceMediaIds ??
    (videoInfo?.sourceMediaId ? [videoInfo.sourceMediaId] : []);
  const storedVideoReference = savedGeneration.videoReference?.sourceMediaId ??
    (typeof savedGeneration.sourceMediaId === "string" ? savedGeneration.sourceMediaId : null);

  return {
    prompt: hydratedPrompt,
    aspectRatio,
    variants: typeof savedForm.variants === "number" && Number.isFinite(savedForm.variants)
      ? Math.max(1, Math.min(4, Math.round(savedForm.variants)))
      : 1,
    camera: savedForm.camera === "dynamic" ? "dynamic" : "static",
    storyboardGrid: normaliseStoryboardGrid(savedForm.storyboardGrid),
    charGender,
    charCountry,
    charVibe,
    charExtras,
    selectedSourceIdx: resolveSelectedSourceIdx(savedForm.selectedSourceIdx, sourceMediaIds),
    t2vLibraryMediaId: savedForm.t2vLibraryMediaId ?? null,
    t2vLibraryMediaItem: (savedForm.t2vLibraryMediaItem as MediaItem | null | undefined) ?? null,
    independentVideoMediaIds: savedForm.independentVideoMediaIds ?? [],
    independentVideoMode: savedForm.independentVideoMode ?? "i2v",
    connectedVideoMode,
    videoExtendMode: savedForm.videoExtendMode === "extend" ? "extend" : "continuation",
    r2vAdditionalMediaIds: savedForm.r2vAdditionalMediaIds ?? [],
    omniVideoMode: isSavedVideoReference
      ? "video_reference"
      : "default",
    videoReferenceMediaId: typeof storedVideoReference === "string" ? storedVideoReference : null,
    backend: backend === "flow" || backend === "muse" ? backend : defaults.mediaProvider,
    imageModel: imageModel === "NANO_BANANA_PRO" || imageModel === "NANO_BANANA_2"
      ? imageModel
      : defaults.imageModel,
    videoModel: videoModel === "veo" || videoModel === "omni_flash"
      ? videoModel
      : defaults.videoModel,
    videoQuality,
    omniFlashDuration: duration === 4 || duration === 6 || duration === 8 || duration === 10
      ? duration
      : defaults.omniFlashDuration,
    omniFlashResolution: resolution === "360p" || resolution === "720p"
      ? resolution
      : defaults.omniFlashResolution,
  };
}

export interface SerializeFormContext {
  targetType: string;
  isVideo: boolean;
  isCharacter: boolean;
  isStoryboard: boolean;
  videoMode: VideoModeType | undefined;
  videoSourceNodeFamily: string | undefined;
  hasAnyIncomingEdge: boolean;
  currentGeneration: NodeGeneration;
}

export function serializeForm(
  form: GenerationFormState,
  context: SerializeFormContext,
): Record<string, unknown> {
  const {
    targetType,
    isVideo,
    isCharacter,
    isStoryboard,
    videoMode,
    videoSourceNodeFamily,
    hasAnyIncomingEdge,
    currentGeneration,
  } = context;
  const isVideoRefActive = isVideo && videoMode !== "r2v" && form.videoModel === "omni_flash" &&
    form.omniVideoMode === "video_reference";
  const videoModel = form.videoModel === "omni_flash"
    ? {
        family: "omni_flash",
        id: isVideoRefActive
          ? "abra_edit"
          : videoMode === "t2v"
            ? `abra_t2v_${form.omniFlashDuration}s${form.omniFlashResolution === "360p" ? "_360p" : ""}`
            : `abra_r2v_${form.omniFlashDuration}s${form.omniFlashResolution === "360p" ? "_360p" : ""}`,
      }
    : { family: "veo", quality: form.videoQuality };
  const isImageNode = targetType === "image" || targetType === "character" || isStoryboard;

  return {
    ...currentGeneration,
    prompt: form.prompt,
    ...(isVideo || isImageNode
      ? {
          backend: form.backend,
          aspectRatio: form.aspectRatio,
          variants: form.variants,
          model: isVideo ? videoModel : { family: "image", id: form.imageModel },
        }
      : {}),
    ...(isVideo
      ? {
          camera: form.camera,
          selectedSourceIdx: form.selectedSourceIdx,
          t2vLibraryMediaId: form.t2vLibraryMediaId,
          t2vLibraryMediaItem: form.t2vLibraryMediaItem,
          independentVideoMediaIds: form.independentVideoMediaIds,
          independentVideoMode: form.independentVideoMode,
          connectedVideoMode: videoMode === "r2v" ? "r2v" : form.connectedVideoMode,
          videoExtendMode: form.videoExtendMode,
          videoMode: isVideoRefActive
            ? "video_reference"
            : videoMode === "r2v"
              ? "r2v"
              : videoMode === "video_continuation"
                ? form.connectedVideoMode === "r2v"
                  ? "r2v"
                  : form.videoExtendMode === "extend" && videoSourceNodeFamily === "veo"
                    ? "extend_video"
                    : "i2v"
                : hasAnyIncomingEdge
                  ? form.connectedVideoMode
                  : form.independentVideoMode,
          videoReference: isVideoRefActive
            ? { sourceMediaId: form.videoReferenceMediaId }
            : undefined,
          r2vAdditionalMediaIds: form.r2vAdditionalMediaIds,
          ...(form.videoModel === "omni_flash"
            ? { duration: form.omniFlashDuration, resolution: form.omniFlashResolution }
            : { duration: null, resolution: null }),
        }
      : {}),
    ...(isCharacter
      ? {
          charGender: form.charGender,
          charCountry: form.charCountry,
          charVibe: form.charVibe,
          charExtras: form.charExtras,
        }
      : {}),
    ...(isStoryboard ? { storyboardGrid: form.storyboardGrid } : {}),
  };
}
