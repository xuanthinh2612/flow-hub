import type { VideoUpstreamInfo } from "../../../utils/videoFrame";

export type VideoUiKey =
  | "video_reference"
  | "independent_t2v"
  | "independent_i2v"
  | "independent_r2v"
  | "continuation_extend"
  | "continuation_omni"
  | "continuation_lastframe"
  | "connected";

export interface ResolveVideoModeInput {
  isVideo: boolean;
  isOmniVideo: boolean;
  omniVideoMode: "default" | "video_reference";
  videoInfo: VideoUpstreamInfo | null;
  independentVideoMediaIds: string[];
  independentVideoMode: "i2v" | "r2v";
  videoExtendMode: "continuation" | "extend";
  totalConnectedSources: number;
  connectedVideoMode: "i2v" | "r2v";
}

export interface ResolvedVideoMode {
  independentVideoEffectiveMode: "t2v" | "i2v" | "r2v" | "video_reference";
  actualConnectedMode: string | undefined;
  isEffectiveR2v: boolean;
  isUpstreamVeoVideo: boolean;
  isExtend: boolean;
  videoUiKey: VideoUiKey;
}

export function resolveVideoMode(input: ResolveVideoModeInput): ResolvedVideoMode {
  const {
    isVideo,
    isOmniVideo,
    omniVideoMode,
    videoInfo,
    independentVideoMediaIds,
    independentVideoMode,
    videoExtendMode,
    totalConnectedSources,
    connectedVideoMode,
  } = input;

  const independentVideoEffectiveMode =
    isOmniVideo && omniVideoMode === "video_reference"
      ? "video_reference"
      : independentVideoMediaIds.length > 1
        ? "r2v"
        : independentVideoMediaIds.length === 1
          ? independentVideoMode
          : "t2v";
  const actualConnectedMode =
    videoInfo?.mode === "i2v"
      ? totalConnectedSources >= 2
        ? "r2v"
        : connectedVideoMode
      : videoInfo?.mode === "video_continuation"
        ? connectedVideoMode
      : videoInfo?.mode;
  const isEffectiveR2v =
    isVideo &&
    (videoInfo?.mode === "i2v" || videoInfo?.mode === "r2v" || videoInfo?.mode === "video_continuation") &&
    actualConnectedMode === "r2v";
  const isUpstreamVeoVideo =
    videoInfo?.mode === "video_continuation" &&
    videoInfo.sourceNodeFamily === "veo";
  const isExtend =
    isUpstreamVeoVideo &&
    !isOmniVideo &&
    omniVideoMode !== "video_reference" &&
    actualConnectedMode !== "r2v" &&
    videoExtendMode === "extend";

  let videoUiKey: VideoUiKey;
  if (isOmniVideo && omniVideoMode === "video_reference") {
    videoUiKey = "video_reference";
  } else if (videoInfo?.mode === "t2v") {
    videoUiKey =
      independentVideoEffectiveMode === "t2v"
        ? "independent_t2v"
        : independentVideoEffectiveMode === "i2v"
          ? "independent_i2v"
          : independentVideoEffectiveMode === "r2v"
            ? "independent_r2v"
            : "video_reference";
  } else if (isEffectiveR2v) {
    videoUiKey = "connected";
  } else if (videoInfo?.mode === "video_continuation") {
    videoUiKey = isExtend
      ? "continuation_extend"
      : isOmniVideo
        ? "continuation_omni"
        : "continuation_lastframe";
  } else if (videoInfo?.mode === "i2v" || videoInfo?.mode === "r2v") {
    videoUiKey = "connected";
  } else {
    videoUiKey = "independent_i2v";
  }

  return {
    independentVideoEffectiveMode,
    actualConnectedMode,
    isEffectiveR2v,
    isUpstreamVeoVideo,
    isExtend,
    videoUiKey,
  };
}

export interface CanSubmitVideoInput {
  isVideo: boolean;
  isOmniVideo: boolean;
  omniVideoMode: "default" | "video_reference";
  videoReferenceMediaId: string | null;
  videoInfo: VideoUpstreamInfo | null;
  hasPendingUpstream: boolean;
  extractingFrame: boolean;
  independentVideoMediaIds: string[];
  prompt: string;
  isExtend: boolean;
  isEffectiveR2v: boolean;
  refSourceNodes: unknown[];
  r2vAdditionalMediaIds: string[];
  selectedSourceCount: number;
}

export function canSubmitVideo(input: CanSubmitVideoInput): boolean {
  const {
    isVideo,
    isOmniVideo,
    omniVideoMode,
    videoReferenceMediaId,
    videoInfo,
    hasPendingUpstream,
    extractingFrame,
    independentVideoMediaIds,
    prompt,
    isExtend,
    isEffectiveR2v,
    refSourceNodes,
    r2vAdditionalMediaIds,
    selectedSourceCount,
  } = input;

  return (
    !isVideo ||
    (isOmniVideo && omniVideoMode === "video_reference"
      ? (Boolean(videoReferenceMediaId) ||
          (videoInfo?.mode === "video_continuation" &&
            (Boolean(videoInfo.sourceMediaId) || hasPendingUpstream))) &&
        !extractingFrame
      : videoInfo?.mode === "t2v"
        ? (prompt.trim().length > 0 || independentVideoMediaIds.length > 0) &&
          !extractingFrame
        : videoInfo?.mode === "video_continuation"
          ? (Boolean(videoInfo.sourceMediaId) || hasPendingUpstream) &&
            (videoInfo.sourceNode?.data.status === "done" || hasPendingUpstream) &&
            (isExtend ? true : !extractingFrame)
          : (isEffectiveR2v
              ? refSourceNodes.length > 0 ||
                r2vAdditionalMediaIds.length > 0 ||
                hasPendingUpstream
              : selectedSourceCount > 0 || hasPendingUpstream) &&
            !extractingFrame)
  );
}

export interface ComputeCanGenerateInput {
  isCharacter: boolean;
  charGender: unknown;
  charCountry: unknown;
  charExtras: string;
  isVideo: boolean;
  isVideoReady: boolean;
  isWorking: boolean;
}

export function computeCanGenerate(input: ComputeCanGenerateInput): boolean {
  const {
    isCharacter,
    charGender,
    charCountry,
    charExtras,
    isVideo,
    isVideoReady,
    isWorking,
  } = input;
  return isCharacter
    ? (charGender !== null || charCountry !== null || charExtras.trim().length > 0) &&
        !isWorking
    : isVideo
      ? isVideoReady && !isWorking
      : !isWorking;
}
