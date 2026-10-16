import { useEffect, useReducer, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useGenerationStore } from "../../store/generation";
import { useBoardStore, type StoryboardGrid } from "../../store/board";
import { normaliseStoryboardGrid } from "../../lib/storyboardPrompt";
import {
  useSettingsStore,
  type MediaProviderKey,
  type OmniFlashDuration,
  type OmniFlashResolution,
  type VideoModelFamily,
  type VideoQuality,
} from "../../store/settings";
import {
  patchEdge,
  uploadImage,
} from "../../canvas/canvasApi";
import {
  getVideoUpstreamInfo,
  type VideoUpstreamInfo,
} from "../../utils/videoFrame";
import {
  type GenderKey,
  type CountryKey,
  type VibeKey,
} from "../../constants/character";
import { REF_SOURCE_TYPES, type CameraKey, type AspectKey } from "./constants";
import { reducer, type RefSourceEntry } from "./types";
import { hydrateForm, serializeForm } from "./lib/formState";
import { cameraInstruction } from "./lib/cameraInstruction";
import { canSubmitVideo, computeCanGenerate, resolveVideoMode } from "./lib/resolveVideoMode";
import { VIDEO_MODE_UI } from "./lib/videoModeUi";
import { CharacterBuilder } from "./sections/CharacterBuilder";
import { OmniOptions } from "./sections/OmniOptions";
import { CameraField } from "./sections/CameraField";
import { VariantsStepper } from "./sections/VariantsStepper";
import { StoryboardGridField } from "./sections/StoryboardGridField";
import { BackendField } from "./sections/BackendField";
import { AspectRatioField } from "./sections/AspectRatioField";
import { VideoModelField } from "./sections/VideoModelField";
import { SourceReferences } from "./sections/SourceReferences";
import { VideoIndependentSource } from "./sections/VideoIndependentSource";
import { VideoConnectedSource } from "./sections/VideoConnectedSource";
import { PromptField } from "./sections/PromptField";
import { useDialogA11y } from "./hooks/useDialogA11y";
import { useCloseOnOutsidePicker } from "./hooks/useCloseOnOutsidePicker";
import { runAutoPrompt } from "./submit/runAutoPrompt";
import { submitStoryboard } from "./submit/submitStoryboard";
import { submitPrompt } from "./submit/submitPrompt";
import { submitCharacter } from "./submit/submitCharacter";
import { submitImage } from "./submit/submitImage";
import { buildVideoSubmit } from "./submit/submitVideo";
export function GenerationDialog() {
  const rfId = useGenerationStore((s) => s.openDialog.rfId);
  const boardId = useBoardStore((s) => s.boardId);
  const boardPublicId = useBoardStore((s) => s.boardPublicId);
  if (rfId === null) return null;
  return (
    <GenerationDialogContent
      key={`${boardId ?? ""}:${boardPublicId ?? "default"}:${rfId}`}
      rfId={rfId}
    />
  );
}

function GenerationDialogContent({ rfId }: { rfId: string }) {
  const openDialog = useGenerationStore((s) => s.openDialog);
  const closeGenerationDialog = useGenerationStore((s) => s.closeGenerationDialog);
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const nodes = useBoardStore((s) => s.nodes);
  const boardPublicId = useBoardStore((s) => s.boardPublicId);


  // Storyboard layout. The node dispatches via the standard image
  // handler with a locked template prompt wrapping the user's topic
  // into a single composite NxN grid. See lib/storyboardPrompt.ts.


  // Character builder state — only used when targetType === "character".


  // Auto-prompt state — set when the user submits an empty prompt and we
  // synthesise one from upstream context. Surfaced as a small ✨ badge.
  const [autoBuilding, setAutoBuilding] = useState(false);
  const [autoPromptUsed, setAutoPromptUsed] = useState(false);

  // Per-variant selection for multi-source i2v. Default: all selected.
  // Stored as a Set of indices so the UI can toggle individual variants
  // and "All / None" without juggling parallel arrays.

  // Tracks which Source-Reference chip's variant picker is currently
  // open. Holds the edge id the picker is anchored to (one open at a
  // time). Click another chip → swap; click the same chip → close;
  // click outside (handled inline) → close.
  const [openVariantPicker, setOpenVariantPicker] = useState<string | null>(null);




  /** Whether the user chose to continue the clip (extract last frame) or
   *  extend it via fZytfe (Veo Extension Lite). Only applies when upstream
   *  is a single Veo video. */

  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [uploadVideoError, setUploadVideoError] = useState<string | null>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLTextAreaElement>(null);

  const node = nodes.find((n) => n.id === rfId);
  const extractingFrame = node?.data.extractingFrame === true;
  const extractError = node?.data.extractError as string | undefined;

  const boardName = useBoardStore((s) => s.boardName);
  const nodeCount = nodes.length;
  const edges = useBoardStore((s) => s.edges);

  // Settings in the dialog belong to this node. Global settings provide
  // defaults only when a node has no canonical generation config yet.
  const defaultVideoModel = useSettingsStore((s) => s.videoModel);
  const defaultVideoQuality = useSettingsStore((s) => s.videoQuality);
  const defaultImageModel = useSettingsStore((s) => s.imageModel);
  const defaultOmniFlashDuration = useSettingsStore((s) => s.omniFlashDuration);
  const defaultOmniFlashResolution = useSettingsStore((s) => s.omniFlashResolution);
  const defaultMediaProvider = useSettingsStore((s) => s.mediaProvider);

  // Auto-detected paygate tier (PAYGATE_TIER_ONE / TIER_TWO). Used to
  // lock the Ultra-only model chips (lite_relaxed) for Pro users — same
  // gating as the SettingsPanel.
  const paygateTier = useGenerationStore((s) => s.paygateTier);

  const [form, patch] = useReducer(
    reducer,
    {
      rfId,
      nodes,
      edges,
      defaults: {
        videoModel: defaultVideoModel,
        videoQuality: defaultVideoQuality,
        imageModel: defaultImageModel,
        omniFlashDuration: defaultOmniFlashDuration,
        omniFlashResolution: defaultOmniFlashResolution,
        mediaProvider: defaultMediaProvider,
      },
      seedPrompt: openDialog.prompt,
      boardPublicId,
    },
    hydrateForm,
  );
  const initialFormRef = useRef(form);
  const {
    prompt,
    aspectRatio,
    variants,
    camera,
    storyboardGrid,
    charGender,
    charCountry,
    charVibe,
    charExtras,
    independentVideoMediaIds,
    independentVideoMode,
    connectedVideoMode,
    videoExtendMode,
    r2vAdditionalMediaIds,
    omniVideoMode = "default",
    videoReferenceMediaId = null,
    backend: mediaProvider,
    videoModel: videoModelFamily,
    videoQuality,
    omniFlashDuration,
    omniFlashResolution,
  } = form;
  const setPrompt = (value: string) => patch({ prompt: value });
  const setAspectRatio = (value: AspectKey) => patch({ aspectRatio: value });
  const setVariants: Dispatch<SetStateAction<number>> = (value) =>
    patch({ variants: typeof value === "function" ? value(variants) : value });
  const setCamera = (value: CameraKey) => patch({ camera: value });
  const setStoryboardGrid = (value: StoryboardGrid) => patch({ storyboardGrid: value });
  const setCharGender = (value: GenderKey | null) => patch({ charGender: value });
  const setCharCountry = (value: CountryKey | null) => patch({ charCountry: value });
  const setCharVibe = (value: VibeKey) => patch({ charVibe: value });
  const setCharExtras = (value: string) => patch({ charExtras: value });
  const setIndependentVideoMediaIds = (value: string[]) => patch({ independentVideoMediaIds: value });
  const setIndependentVideoMode = (value: "i2v" | "r2v") => patch({ independentVideoMode: value });
  const setConnectedVideoMode = (value: "i2v" | "r2v") => patch({ connectedVideoMode: value });
  const setVideoExtendMode = (value: "continuation" | "extend") => patch({ videoExtendMode: value });
  const setR2vAdditionalMediaIds = (value: string[]) => patch({ r2vAdditionalMediaIds: value });
  const setOmniVideoMode = (value: "default" | "video_reference") => patch({ omniVideoMode: value });
  const setVideoReferenceMediaId = (value: string | null) => patch({ videoReferenceMediaId: value });
  const setMediaProvider = (value: MediaProviderKey) => patch({ backend: value });
  const setVideoModel = (value: VideoModelFamily) => patch({ videoModel: value });
  const setVideoQuality = (value: VideoQuality) => patch({ videoQuality: value });
  const setOmniFlashDuration = (value: OmniFlashDuration) => patch({ omniFlashDuration: value });
  const setOmniFlashResolution = (value: OmniFlashResolution) => patch({ omniFlashResolution: value });

  const targetType = node?.data.type ?? "image";
  const isVideo = targetType === "video";
  const isOmniVideo = isVideo && videoModelFamily === "omni_flash";
  const isCharacter = targetType === "character";
  const isStoryboard = targetType === "Storyboard";

  const persistIndependentVideoSelection = (
    mediaIds: string[],
    mode: "i2v" | "r2v" = independentVideoMode,
  ) => {
    setIndependentVideoMediaIds(mediaIds);
    useBoardStore.getState().updateNodeGeneration(rfId, {
      independentVideoMediaIds: mediaIds,
      independentVideoMode: mode,
    });
  };

  const persistIndependentVideoMode = (mode: "i2v" | "r2v") => {
    setIndependentVideoMode(mode);
    useBoardStore.getState().updateNodeGeneration(rfId, {
      independentVideoMediaIds,
      independentVideoMode: mode,
      videoMode: mode,
    });
  };

  async function handleUploadVideoFile(file: File) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      setUploadVideoError("Tệp video quá lớn (tối đa 50 MB)");
      return;
    }
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!['mp4', 'webm', 'mov'].includes(ext || '')) {
      setUploadVideoError("Chỉ chấp nhận tệp video MP4, WEBM, hoặc MOV");
      return;
    }
    setUploadVideoError(null);
    setUploadingVideo(true);
    try {
      const projectId = await useGenerationStore.getState().ensureProjectId();
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(file, projectId || undefined, isNaN(dbId) ? undefined : dbId, boardPublicId || undefined);
      setVideoReferenceMediaId(resp.media_id);
    } catch (err) {
      setUploadVideoError(err instanceof Error ? err.message : "Tải video lên thất bại");
    } finally {
      setUploadingVideo(false);
    }
  }

  // Detailed mode resolution for video nodes: t2v, i2v, or video_continuation
  const videoInfo: VideoUpstreamInfo | null = isVideo
    ? getVideoUpstreamInfo(rfId, nodes, edges)
    : null;
  const hasPendingUpstream = !!videoInfo?.upstreamNodes.some((source) => {
    if (source.data.status === "queued" || source.data.status === "running") return true;
    const hasMedia = Boolean(source.data.mediaId)
      || (Array.isArray(source.data.mediaIds) && source.data.mediaIds.some(Boolean));
    return source.data.status === "idle" && !hasMedia;
  });

  // Omni Flash is a video model but dispatches with ingredient semantics
  // (multi reference images). Display-wise it now mirrors every other
  // video model: the dialog derives its layout purely from the upstream
  // graph (mode + connected sources), and only the Resolution / Duration
  // fields are shown additionally when Omni is selected.
  const rawRefSourceNodeCount = edges
        .filter((e) => e.target === rfId)
        .filter((e) => {
          const n = nodes.find((node) => node.id === e.source);
          return n && REF_SOURCE_TYPES.has(n.data.type);
        }).length;
  const totalConnectedSources = rawRefSourceNodeCount + r2vAdditionalMediaIds.length;
  const resolvedVideoMode = resolveVideoMode({
    isVideo,
    isOmniVideo,
    omniVideoMode,
    videoInfo,
    independentVideoMediaIds,
    independentVideoMode,
    videoExtendMode,
    totalConnectedSources,
    connectedVideoMode,
  });
  const {
    independentVideoEffectiveMode,
    actualConnectedMode,
    isEffectiveR2v,
    isUpstreamVeoVideo,
    isExtend,
    videoUiKey,
  } = resolvedVideoMode;
  const independentVideoModeLabel =
    independentVideoEffectiveMode === "video_reference"
      ? "Video Reference (jIps6)"
      : independentVideoEffectiveMode === "t2v"
        ? "Text → Video (t2v)"
        : independentVideoEffectiveMode === "i2v"
          ? "Image → Video (i2v)"
          : "Ingredients (r2v)";
  const videoModeUiContext = {
    independentVideoEffectiveMode,
    independentVideoModeLabel,
    isOmniVideo,
    isExtend,
    isEffectiveR2v,
    videoInfo,
  };
  const videoUi = VIDEO_MODE_UI[videoUiKey];
  // Prompt nodes are text-only — clicking Generate runs auto_prompt
  // synthesis from upstream context and writes the result back to
  // node.data.generation.prompt. No image dispatch, no aspect/variants.
  const isPrompt = targetType === "prompt";

  // Find upstream source image for video nodes.
  const sourceNode = isVideo ? videoInfo?.sourceNode : undefined;

  // Storyboard → video: when ANY upstream node is a Storyboard composite,
  // the motion prompt MUST follow a fixed template that asks Flow to
  // animate the panels in order. 2x2→4 frames; 2x3→6; 2x4→8. Other
  // refs (character / location / visual_asset) still flow as normal —
  // the prompt itself is what's locked. Pick the first storyboard
  // upstream's grid (multi-storyboard edges are an edge case we don't
  // optimize for).
  const storyboardUpstream = isVideo
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => nodes.find((n) => n.id === e.source))
        .find((n) => n?.data.type === "Storyboard")
    : undefined;
  const hasStoryboardUpstream = !!storyboardUpstream;
  const storyboardUpstreamGrid = normaliseStoryboardGrid(
    storyboardUpstream?.data.generation?.storyboardGrid,
  );
  const sourceMediaId = videoInfo?.sourceMediaId ?? null;
  // Drop null placeholders from the upstream variant list — partial-
  // batch results may carry them, but downstream dispatch needs a
  // dense array of valid mediaIds to feed into Flow.
  const sourceMediaIds: string[] = isVideo
    ? (videoInfo?.sourceMediaIds ?? (sourceMediaId ? [sourceMediaId] : []))
    : [];
  const selectedSourceIdx = new Set(
    form.selectedSourceIdx === null
      ? sourceMediaIds.map((_, index) => index)
      : form.selectedSourceIdx.filter((index) => index >= 0 && index < sourceMediaIds.length),
  );
  const setSelectedSourceIdx: Dispatch<SetStateAction<Set<number>>> = (nextSelection) => {
    const next = typeof nextSelection === "function"
      ? nextSelection(selectedSourceIdx)
      : nextSelection;
    const allSelected = next.size > 0 &&
      next.size === sourceMediaIds.length &&
      sourceMediaIds.every((_, index) => next.has(index));
    patch({ selectedSourceIdx: allSelected ? null : [...next] });
  };

  // Image nodes: list every upstream ref edge feeding this target. We
  // walk edges (not just nodes) so we can read each edge's variant pin
  // and show the EXACT thumbnail Flow will receive — when an edge is
  // pinned to variant 2 of a 4-variant source, the chip shows variant 2,
  // not the source's "active" mediaId. Mirrors the resolution used by
  // `collectUpstreamRefMediaIds` at dispatch time so the preview can't
  // diverge from the actual API call.
  //
  // We also surface the full `allVariants` list + the edge id so the
  // chip can offer a per-source variant picker without re-querying
  // the store on click.
  // Prompt sources — text-only upstream nodes whose `prompt` feeds the
  // auto-prompt synth as context. They have no mediaId so they live in a
  // separate list from refSourceNodes; the dialog renders them as a
  // text-only chip alongside image refs so the user can SEE that a
  // Prompt node is influencing the gen.
  // Both image targets AND video targets in Ingredients (r2v) mode use
  // the ingredient chip list (multi-ref upstream → one chip per edge).
  // Video i2v has its own single-source-with-variant-batch picker below.
  // (Model-agnostic: derived from the connected graph, not from which
  // video model family is selected.)
  const promptSourceNodes = (!isVideo || isEffectiveR2v) && rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => {
          const n = nodes.find((node) => node.id === e.source);
          if (!n || n.data.type !== "prompt") return null;
          const text = typeof n.data.generation?.prompt === "string" ? n.data.generation.prompt : "";
          return { edgeId: e.id, node: n, text };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];

  // NOTE: an upstream ref node that hasn't produced any media yet is kept
  // in the list (mediaId undefined) instead of being dropped — dropping it
  // made the dialog show NO notice at all, so the user never knew a source
  // was still pending. We split into `refSourceNodes` (renderable thumbs)
  // and `pendingRefNodes` (rendered as the unified ⚠ pending notice).
  const refSourceEntries: RefSourceEntry[] = (!isVideo || isEffectiveR2v) && rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => {
          const n = nodes.find((node) => node.id === e.source);
          if (!n || !REF_SOURCE_TYPES.has(n.data.type)) return null;
          const variants = (Array.isArray(n.data.mediaIds) ? n.data.mediaIds : [])
            .filter((m): m is string => typeof m === "string" && m.length > 0);
          const pin = (e.data?.sourceVariantIdx ?? null) as number | null;
          let mediaId: string | undefined;
          let variantIdx: number | null = null;
          if (pin !== null && pin >= 0 && pin < variants.length) {
            mediaId = variants[pin];
            variantIdx = pin;
          } else if (typeof n.data.mediaId === "string" && n.data.mediaId) {
            mediaId = n.data.mediaId;
            // When dispatch falls back to source.mediaId, that's
            // typically variants[0] (gen-result writes mediaId =
            // mediaIds[0]). Surface that as the displayed variantIdx
            // so the chip's badge matches what Flow will receive,
            // even before the user clicks to pin explicitly.
            const idx = variants.indexOf(n.data.mediaId);
            variantIdx = idx >= 0 ? idx : null;
          } else if (variants.length > 0) {
            mediaId = variants[0];
            variantIdx = 0;
          }
          return {
            edgeId: e.id,
            node: n,
            mediaId,
            variantIdx,
            allVariants: variants,
          };
        })
        .filter((entry): entry is RefSourceEntry => entry !== null)
    : [];
  const refSourceNodes = refSourceEntries.filter((e) => Boolean(e.mediaId)) as Array<RefSourceEntry & { mediaId: string }>;
  const pendingRefNodes = refSourceEntries
    .filter((e) => !e.mediaId)
    .map((e) => e.node)
    .filter((source) =>
      !(isEffectiveR2v && videoInfo?.mode === "video_continuation" && source.id === videoInfo.sourceNode?.id),
    );

  const hasAnyIncomingEdge = edges.some((edge) => edge.target === rfId);

  useEffect(() => {
    if (form === initialFormRef.current) return;
    const currentGeneration = useBoardStore.getState().nodes.find((item) => item.id === rfId)?.data.generation ?? {};
    const generation = serializeForm(form, {
      targetType,
      isVideo,
      isCharacter,
      isStoryboard,
      videoMode: videoInfo?.mode,
      videoSourceNodeFamily: videoInfo?.sourceNodeFamily,
      hasAnyIncomingEdge,
      currentGeneration,
    });
    useBoardStore.getState().updateNodeGeneration(rfId, generation);
  }, [
    form,
    rfId,
    targetType,
    isVideo,
    isCharacter,
    isStoryboard,
    videoInfo?.mode,
    videoInfo?.sourceNodeFamily,
    hasAnyIncomingEdge,
  ]);

  useDialogA11y({
    enabled: true,
    dialogRef,
    firstFocusRef,
    onEscape: () => {
      // ESC closes the variant picker first if open, otherwise the dialog.
      if (openVariantPicker !== null) {
        setOpenVariantPicker(null);
        return;
      }
      closeGenerationDialog();
    },
    onSubmit: handleSubmit,
  });
  useCloseOnOutsidePicker(
    openVariantPicker !== null,
    () => setOpenVariantPicker(null),
  );

  /** Pick a different variant on a Source Reference chip. PATCHes the
   * edge so the dispatch path picks the new variant, then mirrors the
   * change into the local store so the chip thumbnail updates without
   * waiting for a board refresh. The pick also surfaces on the canvas
   * via the `v{N}` chip on the edge. */
  async function pickVariantForEdge(edgeId: string, variantIdx: number) {
    setOpenVariantPicker(null);
    const edgeDbId = parseInt(edgeId, 10);
    if (isNaN(edgeDbId)) return;
    try {
      const updated = await patchEdge(edgeDbId, {
        source_variant_idx: variantIdx,
      });
      useBoardStore.getState().updateEdgeData(edgeId, {
        sourceVariantIdx: updated.source_variant_idx,
      });
    } catch (err) {
      useGenerationStore.setState({
        error: `Couldn't pin variant: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function handleSubmit() {
    if (!canGenerate) return;
    if (node?.data.autoPromptStatus === "pending" || node?.data.aiBriefStatus === "pending") return;

    if (isStoryboard) {
      submitStoryboard({ rfId, prompt, storyboardGrid, aspectRatio, variants, dispatchGeneration, closeGenerationDialog });
      return;
    }
    if (isPrompt) {
      submitPrompt(rfId, prompt, closeGenerationDialog);
      return;
    }
    if (isCharacter) {
      submitCharacter({
        rfId, prompt, charGender, charCountry, charVibe, charExtras, aspectRatio, variants,
        dispatchGeneration, closeGenerationDialog,
      });
      return;
    }

    let finalPrompt = prompt;
    let perVariantPrompts: string[] | undefined;
    if (!finalPrompt.trim()) {
      setAutoBuilding(true);
      try {
        const result = await runAutoPrompt({ rfId, isVideo, variants, camera });
        finalPrompt = result.finalPrompt;
        perVariantPrompts = result.perVariantPrompts;
        if (result.displayPrompt !== undefined) setPrompt(result.displayPrompt);
        setAutoPromptUsed(true);
      } catch (err) {
        setAutoBuilding(false);
        useGenerationStore.setState({
          error: err instanceof Error
            ? `Auto-prompt failed: ${err.message}`
            : "Auto-prompt failed",
        });
        return;
      }
      setAutoBuilding(false);
    }

    if (isVideo) {
      const camInstruction = cameraInstruction(camera);
      const videoPrompt = camInstruction ? `${finalPrompt}. ${camInstruction}` : finalPrompt;
      const result = buildVideoSubmit({
        prompt: videoPrompt, aspectRatio, camera, variants, isOmniVideo, omniVideoMode,
        videoReferenceMediaId, videoInfo, r2vAdditionalMediaIds, independentVideoMediaIds,
        independentVideoMode, hasPendingUpstream, isExtend, isEffectiveR2v, refSourceNodes,
        sourceMediaIds, selectedSourceIdx, actualConnectedMode, connectedVideoMode,
      });
      if (!result.ok) {
        useBoardStore.getState().updateNodeData(rfId, { extractError: result.nodeError });
        return;
      }
      if (result.patchGeneration) useBoardStore.getState().updateNodeGeneration(rfId, result.patchGeneration);
      if (result.patchNodeData) useBoardStore.getState().updateNodeData(rfId, result.patchNodeData);
      dispatchGeneration(rfId, result.dispatch);
      closeGenerationDialog();
      return;
    }

    submitImage({ rfId, finalPrompt, perVariantPrompts, aspectRatio, variants, dispatchGeneration, closeGenerationDialog });
  }

  // The dialog's local `autoBuilding` flag covers the in-flight window
  // when THIS dialog instance is composing. But the dialog can be closed
  // + reopened mid-flight, leaving the local flag fresh while the node-
  // level `autoPromptStatus` / `aiBriefStatus` is still pending from the
  // first run. Treat both signals as "busy" so the user can't double-fire.
  const nodeLLMBusy =
    node?.data.autoPromptStatus === "pending"
    || node?.data.aiBriefStatus === "pending";
  const isGeneratingMedia =
    node?.data.status === "queued" || node?.data.status === "running";
  const isWorking = autoBuilding || nodeLLMBusy || isGeneratingMedia || extractingFrame || uploadingVideo;

  // Both image and video allow empty prompt — we'll auto-synth on submit.
  // Veo i2v needs at least one selected source variant; Omni Flash
  // needs at least one ingredient (any upstream image-bearing node).
  // t2v requires prompt. video_continuation requires upstream video to be done.
  const isVideoReady = canSubmitVideo({
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
    selectedSourceCount: selectedSourceIdx.size,
  });

  // FIX(bug 2): Keep character generation disabled while any work is running.
  const canGenerate = computeCanGenerate({
    isCharacter,
    charGender,
    charCountry,
    charExtras,
    isVideo,
    isVideoReady,
    isWorking,
  });

  return (
    <div
      className="gen-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeGenerationDialog();
      }}
    >
      <div
        className="gen-dialog"
        role="dialog"
        aria-labelledby="gen-dialog-title"
        aria-modal="true"
        ref={dialogRef}
      >
        {/* Header */}
        <div className="gen-dialog__header">
          <div>
            <h2 id="gen-dialog-title" className="gen-dialog__title">
              {isVideo
                ? videoUi.title
                : isCharacter
                ? "Generate character"
                : isStoryboard
                ? "Generate storyboard"
                : isPrompt
                ? "Edit prompt"
                : "Generate image"}
            </h2>
            <span className="gen-dialog__subtitle">
              Node #{node?.data.shortId ?? rfId}
              {isVideo && videoInfo && (
                <span className={`gen-dialog__mode-badge gen-dialog__mode-badge--${videoUi.badgeClass(videoModeUiContext)}`}>
                  {videoUi.badgeLabel(videoModeUiContext)}
                </span>
              )}
            </span>
          </div>
          <button
            className="gen-dialog__close"
            onClick={closeGenerationDialog}
            aria-label="Close dialog (Escape)"
          >
            esc
          </button>
        </div>

        <PromptField
          isVideo={isVideo}
          isPrompt={isPrompt}
          isWorking={isWorking}
          extractingFrame={extractingFrame}
          extractError={extractError}
          hasStoryboardUpstream={hasStoryboardUpstream}
          storyboardUpstreamGrid={storyboardUpstreamGrid}
          prompt={prompt}
          setPrompt={setPrompt}
          autoPromptUsed={autoPromptUsed}
          setAutoPromptUsed={setAutoPromptUsed}
          firstFocusRef={firstFocusRef}
          videoPlaceholder={videoUi.placeholder}
          aiBriefStatus={node?.data.aiBriefStatus}
        />

        <CharacterBuilder
          isCharacter={isCharacter}
          charGender={charGender}
          setCharGender={setCharGender}
          charCountry={charCountry}
          setCharCountry={setCharCountry}
          charVibe={charVibe}
          setCharVibe={setCharVibe}
          charExtras={charExtras}
          setCharExtras={setCharExtras}
          isWorking={isWorking}
        />

        {/* Source image / video source info (t2v, continuation, or i2v) */}
        <VideoIndependentSource
          isVideo={isVideo}
          videoInfo={videoInfo}
          isOmniVideo={isOmniVideo}
          omniVideoMode={omniVideoMode}
          setOmniVideoMode={setOmniVideoMode}
          uploadVideoError={uploadVideoError}
          videoReferenceMediaId={videoReferenceMediaId}
          setVideoReferenceMediaId={setVideoReferenceMediaId}
          boardPublicId={boardPublicId}
          isWorking={isWorking}
          uploadingVideo={uploadingVideo}
          videoFileInputRef={videoFileInputRef}
          handleUploadVideoFile={handleUploadVideoFile}
          r2vAdditionalMediaIds={r2vAdditionalMediaIds}
          setR2vAdditionalMediaIds={setR2vAdditionalMediaIds}
          independentVideoMediaIds={independentVideoMediaIds}
          persistIndependentVideoMode={persistIndependentVideoMode}
          independentVideoMode={independentVideoMode}
          persistIndependentVideoSelection={persistIndependentVideoSelection}
        />

        <VideoConnectedSource
          isVideo={isVideo}
          videoInfo={videoInfo}
          isExtend={isExtend}
          isOmniVideo={isOmniVideo}
          omniVideoMode={omniVideoMode}
          setOmniVideoMode={setOmniVideoMode}
          isUpstreamVeoVideo={isUpstreamVeoVideo}
          videoExtendMode={videoExtendMode}
          setVideoExtendMode={setVideoExtendMode}
          isWorking={isWorking}
          totalConnectedSources={totalConnectedSources}
          connectedVideoMode={connectedVideoMode}
          setConnectedVideoMode={setConnectedVideoMode}
          actualConnectedMode={actualConnectedMode}
          sourceMediaIds={sourceMediaIds}
          sourceNode={sourceNode}
          selectedSourceIdx={selectedSourceIdx}
          setSelectedSourceIdx={setSelectedSourceIdx}
        />

        <SourceReferences
          isVideo={isVideo}
          isEffectiveR2v={isEffectiveR2v}
          refSourceNodes={refSourceNodes}
          promptSourceNodes={promptSourceNodes}
          pendingRefNodes={pendingRefNodes}
          openVariantPicker={openVariantPicker}
          setOpenVariantPicker={setOpenVariantPicker}
          boardPublicId={boardPublicId}
          isWorking={isWorking}
          r2vAdditionalMediaIds={r2vAdditionalMediaIds}
          setR2vAdditionalMediaIds={setR2vAdditionalMediaIds}
          pickVariantForEdge={pickVariantForEdge}
        />

        <BackendField isPrompt={isPrompt} mediaProvider={mediaProvider} setMediaProvider={setMediaProvider} isWorking={isWorking} />

        <AspectRatioField isPrompt={isPrompt} isVideo={isVideo} aspectRatio={aspectRatio} setAspectRatio={setAspectRatio} isWorking={isWorking} />

        <VideoModelField
          isVideo={isVideo}
          isExtend={isExtend}
          videoModelFamily={videoModelFamily}
          videoQuality={videoQuality}
          setVideoModel={setVideoModel}
          setVideoQuality={setVideoQuality}
          isWorking={isWorking}
          paygateTier={paygateTier}
        />

        <OmniOptions
          isOmniVideo={isOmniVideo}
          omniFlashResolution={omniFlashResolution}
          setOmniFlashResolution={setOmniFlashResolution}
          omniFlashDuration={omniFlashDuration}
          setOmniFlashDuration={setOmniFlashDuration}
          isWorking={isWorking}
        />

        <CameraField isVideo={isVideo} camera={camera} setCamera={setCamera} isWorking={isWorking} />

        <VariantsStepper isVideo={isVideo} isPrompt={isPrompt} variants={variants} setVariants={setVariants} isWorking={isWorking} />

        <StoryboardGridField isStoryboard={isStoryboard} storyboardGrid={storyboardGrid} setStoryboardGrid={setStoryboardGrid} aspectRatio={aspectRatio} isWorking={isWorking} />

        {/* Footer */}
        <div className="gen-dialog__footer">
          <span className="gen-dialog__board-ctx">
            {boardName} · {nodeCount} node{nodeCount !== 1 ? "s" : ""}
          </span>
          <button
            className="gen-dialog__cta"
            type="button"
            onClick={handleSubmit}
            disabled={!canGenerate}
            title={
              isGeneratingMedia
                ? "Đang render video…"
                : nodeLLMBusy && !autoBuilding
                ? "Backend is still composing — try again in a moment"
                : undefined
            }
          >
            {extractingFrame
              ? "Đang trích frame…"
              : isGeneratingMedia
              ? "Đang render…"
              : isWorking
              ? "Building…"
              : isPrompt
              ? "Save ⌘↵"
              : "Generate ⌘↵"}
          </button>
        </div>
      </div>
    </div>
  );
}
