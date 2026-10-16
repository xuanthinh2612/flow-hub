import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../../store/generation";
import { useBoardStore, type StoryboardGrid } from "../../store/board";
import {
  buildStoryboardPrompt,
  buildStoryboardVideoPrompt,
  normaliseStoryboardGrid,
} from "../../lib/storyboardPrompt";
import {
  useSettingsStore,
  type ImageModelKey,
  type MediaProviderKey,
  type OmniFlashDuration,
  type OmniFlashResolution,
  type VideoModelFamily,
  type VideoQuality,
} from "../../store/settings";
import {
  autoPrompt as autoPromptApi,
  autoPromptBatch as autoPromptBatchApi,
  patchEdge,
  patchNode,
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
import type { MediaItem } from "../../api/types";
import { REF_SOURCE_TYPES, IMAGE_ASPECT_RATIOS, VIDEO_ASPECT_RATIOS, type CameraKey, type AspectKey } from "./constants";
import { type RefSourceEntry, type GenerationFormState } from "./types";
import { buildCharacterPrompt } from "./lib/characterPrompt";
import { cameraInstruction } from "./lib/cameraInstruction";
import { pickDefaultAspect } from "./lib/aspect";
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
export function GenerationDialog() {
  const openDialog = useGenerationStore((s) => s.openDialog);
  const closeGenerationDialog = useGenerationStore((s) => s.closeGenerationDialog);
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const nodes = useBoardStore((s) => s.nodes);
  const boardId = useBoardStore((s) => s.boardId);
  const boardPublicId = useBoardStore((s) => s.boardPublicId);

  const [prompt, setPrompt] = useState(openDialog.prompt);
  const [aspectRatio, setAspectRatio] = useState<AspectKey>("IMAGE_ASPECT_RATIO_LANDSCAPE");
  const [variants, setVariants] = useState(1);
  const [camera, setCamera] = useState<CameraKey>("static");
  // Storyboard layout. The node dispatches via the standard image
  // handler with a locked template prompt wrapping the user's topic
  // into a single composite NxN grid. See lib/storyboardPrompt.ts.
  const [storyboardGrid, setStoryboardGrid] = useState<StoryboardGrid>("2x2");

  // Character builder state — only used when targetType === "character".
  const [charGender, setCharGender] = useState<GenderKey | null>(null);
  const [charCountry, setCharCountry] = useState<CountryKey | null>(null);
  const [charVibe, setCharVibe] = useState<VibeKey>("clean");
  const [charExtras, setCharExtras] = useState("");

  // Auto-prompt state — set when the user submits an empty prompt and we
  // synthesise one from upstream context. Surfaced as a small ✨ badge.
  const [autoBuilding, setAutoBuilding] = useState(false);
  const [autoPromptUsed, setAutoPromptUsed] = useState(false);

  // Per-variant selection for multi-source i2v. Default: all selected.
  // Stored as a Set of indices so the UI can toggle individual variants
  // and "All / None" without juggling parallel arrays.
  const [selectedSourceIdx, setSelectedSourceIdx] = useState<Set<number>>(new Set());
  // Tracks which Source-Reference chip's variant picker is currently
  // open. Holds the edge id the picker is anchored to (one open at a
  // time). Click another chip → swap; click the same chip → close;
  // click outside (handled inline) → close.
  const [openVariantPicker, setOpenVariantPicker] = useState<string | null>(null);

  const [t2vLibraryMediaId, setT2vLibraryMediaId] = useState<string | null>(null);
  const [t2vLibraryMediaItem, setT2vLibraryMediaItem] = useState<MediaItem | null>(null);

  const [independentVideoMediaIds, setIndependentVideoMediaIds] = useState<string[]>([]);
  const [independentVideoMode, setIndependentVideoMode] = useState<"i2v" | "r2v">("i2v");
  const [connectedVideoMode, setConnectedVideoMode] = useState<"i2v" | "r2v">("i2v");
  /** Whether the user chose to continue the clip (extract last frame) or
   *  extend it via fZytfe (Veo Extension Lite). Only applies when upstream
   *  is a single Veo video. */
  const [videoExtendMode, setVideoExtendMode] = useState<"continuation" | "extend">("continuation");
  const [r2vAdditionalMediaIds, setR2vAdditionalMediaIds] = useState<string[]>([]);
  const [omniVideoMode, setOmniVideoMode] = useState<"default" | "video_reference">("default");
  const [videoReferenceMediaId, setVideoReferenceMediaId] = useState<string | null>(null);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [uploadVideoError, setUploadVideoError] = useState<string | null>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLTextAreaElement>(null);
  const skipInitialFormSave = useRef<string | null>(null);

  const rfId = openDialog.rfId;
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
  const [videoModelFamily, setVideoModel] = useState<VideoModelFamily>(defaultVideoModel);
  const [videoQuality, setVideoQuality] = useState<VideoQuality>(defaultVideoQuality);
  const [imageModel, setImageModel] = useState<ImageModelKey>(defaultImageModel);
  const [omniFlashDuration, setOmniFlashDuration] = useState<OmniFlashDuration>(defaultOmniFlashDuration);
  const [omniFlashResolution, setOmniFlashResolution] = useState<OmniFlashResolution>(defaultOmniFlashResolution);
  const [mediaProvider, setMediaProvider] = useState<MediaProviderKey>(defaultMediaProvider);
  // Auto-detected paygate tier (PAYGATE_TIER_ONE / TIER_TWO). Used to
  // lock the Ultra-only model chips (lite_relaxed) for Pro users — same
  // gating as the SettingsPanel.
  const paygateTier = useGenerationStore((s) => s.paygateTier);

  const targetType = node?.data.type ?? "image";
  const isVideo = targetType === "video";
  const isOmniVideo = isVideo && videoModelFamily === "omni_flash";
  const isCharacter = targetType === "character";
  const isStoryboard = targetType === "Storyboard";

  const persistIndependentVideoSelection = (
    mediaIds: string[],
    mode: "i2v" | "r2v" = independentVideoMode,
  ) => {
    if (rfId === null) return;
    setIndependentVideoMediaIds(mediaIds);
    useBoardStore.getState().updateNodeGeneration(rfId, {
      independentVideoMediaIds: mediaIds,
      independentVideoMode: mode,
    });
  };

  const persistIndependentVideoMode = (mode: "i2v" | "r2v") => {
    if (rfId === null) return;
    setIndependentVideoMode(mode);
    useBoardStore.getState().updateNodeGeneration(rfId, {
      independentVideoMediaIds,
      independentVideoMode: mode,
      videoMode: mode,
    });
  };

  async function handleUploadVideoFile(file: File) {
    if (!file || rfId === null) return;
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
  const videoInfo: VideoUpstreamInfo | null = isVideo && rfId
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
  const rawRefSourceNodeCount = rfId
    ? edges
        .filter((e) => e.target === rfId)
        .filter((e) => {
          const n = nodes.find((node) => node.id === e.source);
          return n && REF_SOURCE_TYPES.has(n.data.type);
        }).length
    : 0;
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
    .map((e) => e.node);

  // Reset form when dialog opens for a different node
  useEffect(() => {
    if (rfId !== null) {
      const formKey = `${boardPublicId ?? "default"}:${rfId}`;
      let savedForm: Partial<GenerationFormState> = {};
      const persistedNode = nodes.find((node) => node.id === rfId);
      const storedGeneration = persistedNode?.data.generation;
      const savedGeneration = storedGeneration && typeof storedGeneration === "object"
        ? storedGeneration as Record<string, unknown>
        : {};
      savedForm = savedGeneration as Partial<GenerationFormState>;
      const storedModel = savedGeneration.model && typeof savedGeneration.model === "object"
        ? savedGeneration.model as Record<string, unknown>
        : {};
      const savedBackend = savedForm.backend ?? savedGeneration.backend ?? defaultMediaProvider;
      setMediaProvider(savedBackend === "flow" || savedBackend === "muse" ? savedBackend : defaultMediaProvider);
      const savedImageModel = storedModel.family === "image" ? storedModel.id : defaultImageModel;
      setImageModel(savedImageModel === "NANO_BANANA_PRO" || savedImageModel === "NANO_BANANA_2" ? savedImageModel : defaultImageModel);
      const savedVideoModel = storedModel.family;
      setVideoModel(savedVideoModel === "veo" || savedVideoModel === "omni_flash" ? savedVideoModel : defaultVideoModel);
      const savedVideoQuality = storedModel.quality;
      setVideoQuality(savedVideoQuality === "fast" || savedVideoQuality === "lite" || savedVideoQuality === "quality" || savedVideoQuality === "lite_relaxed" ? savedVideoQuality : defaultVideoQuality);
      const savedDuration = savedGeneration.duration;
      setOmniFlashDuration(savedDuration === 4 || savedDuration === 6 || savedDuration === 8 || savedDuration === 10 ? savedDuration : defaultOmniFlashDuration);
      const savedResolution = savedGeneration.resolution;
      setOmniFlashResolution(savedResolution === "360p" || savedResolution === "720p" ? savedResolution : defaultOmniFlashResolution);
      // The following state setters hydrate the form. Skip the first save
      // effect for this node so its pre-hydration render cannot overwrite
      // the saved draft with defaults.
      skipInitialFormSave.current = formKey;

      // Default: whatever prompt the caller seeded (last-saved on the node,
      // or empty for a fresh gen). Storyboard→video overrides this below
      // with the locked motion template.
      let initialPrompt = openDialog.prompt;
      const openNode = persistedNode;
      const openNodeType = openNode?.data.type ?? "image";
      if (openNodeType === "video") {
        const sb = useBoardStore
          .getState()
          .edges.filter((e) => e.target === rfId)
          .map((e) =>
            useBoardStore.getState().nodes.find((n) => n.id === e.source),
          )
          .find((n) => n?.data.type === "Storyboard");
        if (sb) {
          const g = normaliseStoryboardGrid(sb.data.generation?.storyboardGrid);
          initialPrompt = buildStoryboardVideoPrompt(g);
        }
      }
      setPrompt(typeof savedForm.prompt === "string" ? savedForm.prompt : initialPrompt);
      // Character → always 1:1 portrait headshot (its own opinionated
      // default; ignores upstream aspect because character is the source).
      // Image / video → match upstream aspect when available; fall back to
      // landscape (image) / landscape (video) when the graph has no info.
      let nextAspect: AspectKey;
      if (openNodeType === "character") {
        nextAspect = "IMAGE_ASPECT_RATIO_SQUARE";
      } else {
        const inherited = pickDefaultAspect(
          rfId,
          openNodeType,
          nodes,
          useBoardStore.getState().edges,
        );
        if (inherited !== null) {
          nextAspect = inherited;
        } else if (openNodeType === "video") {
          nextAspect = "VIDEO_ASPECT_RATIO_LANDSCAPE";
        } else {
          nextAspect = "IMAGE_ASPECT_RATIO_LANDSCAPE";
        }
      }
      const validAspects = [...IMAGE_ASPECT_RATIOS, ...VIDEO_ASPECT_RATIOS].map((item) => item.key);
      setAspectRatio(
        typeof savedForm.aspectRatio === "string" && validAspects.includes(savedForm.aspectRatio as AspectKey)
          ? savedForm.aspectRatio as AspectKey
          : nextAspect,
      );
      setVariants(
        typeof savedForm.variants === "number" && Number.isFinite(savedForm.variants)
          ? Math.max(1, Math.min(4, Math.round(savedForm.variants)))
          : 1,
      );
      setCamera(savedForm.camera === "dynamic" ? "dynamic" : "static");
      // Hydrate storyboard grid from existing node data when reopening.
      // Fresh nodes + legacy values ("3x3" from 1.2.15-1.2.18) → "2x2".
      const openNodeData = useBoardStore
        .getState()
        .nodes.find((n) => n.id === rfId)?.data;
      setStoryboardGrid(
        normaliseStoryboardGrid(savedForm.storyboardGrid),
      );
      
      const initCharGender = savedForm.charGender ?? (openNodeData?.generation?.charGender as GenderKey) ?? null;
      const initCharCountry = savedForm.charCountry ?? (openNodeData?.generation?.charCountry as CountryKey) ?? null;
      const initCharVibe = savedForm.charVibe ?? (openNodeData?.generation?.charVibe as VibeKey) ?? "clean";
      const initCharExtras = savedForm.charExtras ?? (openNodeData?.generation?.charExtras as string) ?? "";
      
      setCharGender(initCharGender);
      setCharCountry(initCharCountry);
      setCharVibe(initCharVibe);
      setCharExtras(initCharExtras);
      
      if (openNodeType === "character" && !initialPrompt && typeof savedForm.prompt !== "string") {
        setPrompt(buildCharacterPrompt(initCharGender, initCharCountry, initCharVibe, initCharExtras));
      }
      setAutoBuilding(false);
      setAutoPromptUsed(false);
      setT2vLibraryMediaId(savedForm.t2vLibraryMediaId ?? null);
      setT2vLibraryMediaItem(savedForm.t2vLibraryMediaItem ?? null);
      // Default-select every upstream source variant for video targets so
      // the user just hits Generate when they want all videos.
      const upstreamEdge = useBoardStore
        .getState()
        .edges.find((e) => e.target === rfId);
      const upstreamNode = upstreamEdge
        ? useBoardStore.getState().nodes.find((n) => n.id === upstreamEdge.source)
        : undefined;
      const ups =
        upstreamNode?.data.mediaIds ??
        (upstreamNode?.data.mediaId ? [upstreamNode.data.mediaId] : []);
      const restoredSourceIdx = Array.isArray(savedForm.selectedSourceIdx)
        ? savedForm.selectedSourceIdx.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < ups.length)
        : ups.map((_, i) => i);
      setSelectedSourceIdx(new Set(restoredSourceIdx));
      
      setIndependentVideoMediaIds(
        savedForm.independentVideoMediaIds ?? [],
      );
      setIndependentVideoMode(
        savedForm.independentVideoMode ?? "i2v",
      );
      setConnectedVideoMode(
        savedForm.connectedVideoMode ?? "i2v",
      );
      setVideoExtendMode(
        savedForm.videoExtendMode === "extend" ? "extend" : "continuation",
      );
      setR2vAdditionalMediaIds(
        savedForm.r2vAdditionalMediaIds ?? [],
      );

      const storedVideoRef = savedGeneration.videoReference?.sourceMediaId
        ?? savedForm.videoReferenceMediaId
        ?? (typeof savedGeneration.sourceMediaId === "string" ? savedGeneration.sourceMediaId : null);
      setVideoReferenceMediaId(typeof storedVideoRef === "string" ? storedVideoRef : null);

      const isVideoRefMode = savedGeneration.videoMode === "video_reference"
        || savedForm.omniVideoMode === "video_reference";
      setOmniVideoMode(isVideoRefMode ? "video_reference" : "default");
      setUploadVideoError(null);
      setUploadingVideo(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfId, boardId, boardPublicId]);

  // Keep the node settings synchronized so closing the dialog or reloading the page does
  // not discard any prompt, setting, or source selection.
  useEffect(() => {
    if (rfId === null) return;
    const key = `${boardPublicId ?? "default"}:${rfId}`;
    if (skipInitialFormSave.current === key) {
      skipInitialFormSave.current = null;
      return;
    }
    const draft: GenerationFormState = {
      prompt,
      aspectRatio,
      variants,
      camera,
      storyboardGrid,
      charGender,
      charCountry,
      charVibe,
      charExtras,
      selectedSourceIdx: [...selectedSourceIdx],
      t2vLibraryMediaId,
      t2vLibraryMediaItem,
      independentVideoMediaIds,
      independentVideoMode,
      connectedVideoMode,
      videoExtendMode,
      r2vAdditionalMediaIds,
      omniVideoMode,
      videoReferenceMediaId,
      backend: mediaProvider,
      imageModel,
      videoModel: videoModelFamily,
      videoQuality,
      omniFlashDuration,
      omniFlashResolution,
    };
    const isVideoRefActive = isVideo && draft.videoModel === "omni_flash" && draft.omniVideoMode === "video_reference";
    const videoModel = draft.videoModel === "omni_flash"
      ? { family: "omni_flash", id: isVideoRefActive ? "abra_edit" : `abra_r2v_${draft.omniFlashDuration}s${draft.omniFlashResolution === "360p" ? "_360p" : ""}` }
      : { family: "veo", quality: draft.videoQuality };
    const currentGeneration = useBoardStore.getState().nodes.find((item) => item.id === rfId)?.data.generation ?? {};
    const isImageNode = targetType === "image" || targetType === "character" || isStoryboard;
    const generation = {
      ...currentGeneration,
      prompt: draft.prompt,
      ...(isVideo || isImageNode ? {
        backend: draft.backend,
        aspectRatio: draft.aspectRatio,
        variants: draft.variants,
        model: isVideo ? videoModel : { family: "image", id: draft.imageModel },
      } : {}),
      ...(isVideo ? {
        camera: draft.camera,
        selectedSourceIdx: draft.selectedSourceIdx,
        t2vLibraryMediaId: draft.t2vLibraryMediaId,
        t2vLibraryMediaItem: draft.t2vLibraryMediaItem,
        independentVideoMediaIds: draft.independentVideoMediaIds,
        independentVideoMode: draft.independentVideoMode,
        connectedVideoMode: draft.connectedVideoMode,
        videoExtendMode: draft.videoExtendMode,
        videoMode: (isVideoRefActive
          ? "video_reference"
          : (useBoardStore.getState().edges.some((edge) => edge.target === rfId)
              ? (videoInfo?.mode === "video_continuation" && videoInfo.sourceNodeFamily === "veo" && draft.videoExtendMode === "extend" ? "extend_video" : draft.connectedVideoMode)
              : draft.independentVideoMode)) as "t2v" | "i2v" | "r2v" | "extend_video" | "video_reference",
        videoReference: isVideoRefActive ? { sourceMediaId: draft.videoReferenceMediaId } : undefined,
        r2vAdditionalMediaIds: draft.r2vAdditionalMediaIds,
        ...(draft.videoModel === "omni_flash"
          ? { duration: draft.omniFlashDuration, resolution: draft.omniFlashResolution }
          : { duration: null, resolution: null }),
      } : {}),
      ...(isCharacter ? {
        charGender: draft.charGender,
        charCountry: draft.charCountry,
        charVibe: draft.charVibe,
        charExtras: draft.charExtras,
      } : {}),
      ...(isStoryboard ? { storyboardGrid: draft.storyboardGrid } : {}),
    };
    useBoardStore.getState().updateNodeGeneration(rfId, generation);
  }, [
    rfId,
    boardId,
    boardPublicId,
    prompt,
    aspectRatio,
    variants,
    camera,
    storyboardGrid,
    charGender,
    charCountry,
    charVibe,
    charExtras,
    selectedSourceIdx,
    t2vLibraryMediaId,
    t2vLibraryMediaItem,
    independentVideoMediaIds,
    independentVideoMode,
    connectedVideoMode,
    r2vAdditionalMediaIds,
    omniVideoMode,
    videoReferenceMediaId,
    mediaProvider,
    imageModel,
    videoModelFamily,
    videoQuality,
    omniFlashDuration,
    omniFlashResolution,
    isVideo,
  ]);

  useDialogA11y({
    enabled: rfId !== null,
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

  if (rfId === null) return null;

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
    // FIX(bug 1): Keep keyboard submits behind the same readiness guard as the button.
    if (!canGenerate) return;
    if (!rfId) return;
    // Defense in depth — block submit if the LLM layer is still composing
    // for this node from a prior dialog session. The Generate button is
    // already `disabled` at this point, but the user could still trigger
    // ⌘↵ via keyboard.
    if (
      node?.data.autoPromptStatus === "pending"
      || node?.data.aiBriefStatus === "pending"
    ) {
      return;
    }
    if (isStoryboard) {
      // Storyboard is a thin image-node wrapper. The user's prompt
      // textarea is the TOPIC; we wrap it in the locked template and
      // dispatch via the standard image path — Flow renders a single
      // composite NxN grid that visually narrates the topic.
      const wrapped = buildStoryboardPrompt(
        prompt,
        storyboardGrid,
        aspectRatio,
      );
      // Persist the chosen grid + topic on the node so reload shows
      // the same settings and `StoryboardBody` can render the grid badge.
      useBoardStore.getState().updateNodeGeneration(rfId, { prompt, storyboardGrid });
      useBoardStore.getState().updateNodeData(rfId, { aiBrief: prompt });
      const dbId = parseInt(rfId, 10);
      if (!isNaN(dbId)) patchNode(dbId, { data: { aiBrief: prompt } }).catch(() => {});
      dispatchGeneration(rfId, {
        prompt: wrapped,
        aspectRatio,
        kind: "image",
        variantCount: variants,
      });
      closeGenerationDialog();
      return;
    }
    if (isPrompt) {
      // Prompt nodes are user-authored seed text. The dialog is just
      // an editor — Save persists whatever the user typed (or cleared).
      // No auto-synth, no image/video dispatch. Downstream image/video
      // nodes pick up this prompt as upstream context at their own
      // dispatch time.
      const finalPrompt = prompt;
      useBoardStore.getState().updateNodeGeneration(rfId, { prompt: finalPrompt });
      useBoardStore.getState().updateNodeData(rfId, {
        status: finalPrompt.trim() ? "done" : "idle",
      });
      const dbId = parseInt(rfId, 10);
      if (!isNaN(dbId)) patchNode(dbId, { status: finalPrompt.trim() ? "done" : "idle" }).catch(() => {});
      closeGenerationDialog();
      return;
    }
    if (isCharacter) {
      const built = buildCharacterPrompt(charGender, charCountry, charVibe, charExtras);
      const finalPrompt = prompt.trim() || built;
      // Stamp the picker selections directly onto the node so the detail
      // panel can show "Country: Nhật Bản · Vibe: Douyin" later. These
      // choices don't round-trip through the backend params (they're
      // baked into the prompt text), so we persist them here at dispatch
      // time. patchNode merges, so this fires alongside the generation
      // store's own status patches without colliding.
      useBoardStore.getState().updateNodeGeneration(rfId, {
        prompt: finalPrompt, charCountry, charVibe, charGender, charExtras,
      });
      dispatchGeneration(rfId, {
        prompt: finalPrompt,
        aspectRatio,
        variantCount: variants,
      });
      closeGenerationDialog();
      return;
    }
    // Image / video branch — if user left the prompt blank, synthesise
    // from upstream briefs (composition prompt for image, motion prompt
    // for video) before dispatching. For image with variants > 1 use the
    // batch endpoint so each variant gets its own pose-distinct prompt.
    let finalPrompt = prompt;
    let perVariantPrompts: string[] | undefined;
    if (!finalPrompt.trim()) {
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) {
        // FIX(bug 8): Surface invalid node ids instead of silently ignoring auto-prompt.
        useGenerationStore.setState({ error: "Auto-prompt failed: invalid node id" });
        return;
      }
      setAutoBuilding(true);
      // Mark the target node as "auto-prompt running" so the canvas
      // can render a busy treatment + block duplicate dispatches on
      // the same node. Cleared in finally below regardless of outcome.
      useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "pending" });
      try {
        if (!isVideo && variants > 1) {
          const res = await autoPromptBatchApi(dbId, variants);
          perVariantPrompts = res.prompts;
          finalPrompt = res.prompts[0] ?? "";
          setPrompt(res.prompts.join("\n\n— variant —\n\n"));
        } else {
          const res = await autoPromptApi(dbId, isVideo ? { camera } : undefined);
          finalPrompt = res.prompt;
          setPrompt(finalPrompt);
        }
        setAutoPromptUsed(true);
        useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
      } catch (err) {
        setAutoBuilding(false);
        useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "failed" });
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
      // Append the camera-movement constraint to whatever motion prompt
      // we have (manual or auto-synthesised). Putting it last makes it
      // the dominant instruction the model resolves against — overrides
      // any conflicting "slow dolly-in" the synthesizer might have output.
      const camInstruction = cameraInstruction(camera);
      const videoPrompt = camInstruction
        ? `${finalPrompt}. ${camInstruction}`
        : finalPrompt;

      // 0. Video Reference (Omni Flash abra_edit - jIps6)
      if (isOmniVideo && omniVideoMode === "video_reference") {
        const refMid = videoReferenceMediaId || (videoInfo?.mode === "video_continuation" ? videoInfo.sourceMediaId : null);
        if (!refMid) {
          useBoardStore.getState().updateNodeData(rfId, {
            extractError: "Vui lòng chọn hoặc tải lên video tham chiếu.",
          });
          return;
        }
        useBoardStore.getState().updateNodeGeneration(rfId, {
          videoMode: "video_reference",
          videoReference: { sourceMediaId: refMid },
          r2vAdditionalMediaIds,
        });
        dispatchGeneration(rfId, {
          prompt: videoPrompt,
          aspectRatio,
          kind: "video",
          cameraMode: camera,
          videoMode: "video_reference",
          sourceMediaId: refMid,
          sourceMediaIds: r2vAdditionalMediaIds.length > 0 ? r2vAdditionalMediaIds : undefined,
          variantCount: variants,
        });
        closeGenerationDialog();
        return;
      }

      // 1. Text-to-Video (không có node nối trước) / Independent Video
      if (videoInfo?.mode === "t2v") {
        const actualMode = independentVideoMediaIds.length > 1 
          ? "r2v" 
          : independentVideoMediaIds.length === 1 
            ? independentVideoMode 
            : "t2v";

        useBoardStore.getState().updateNodeGeneration(rfId, {
          independentVideoMediaIds,
          independentVideoMode,
          videoMode: actualMode,
        });

        dispatchGeneration(rfId, {
          prompt: videoPrompt,
          aspectRatio,
          kind: "video",
          cameraMode: camera,
          videoMode: actualMode,
          sourceMediaIds: independentVideoMediaIds.length > 0 ? independentVideoMediaIds : undefined,
          variantCount: variants,
        });
        closeGenerationDialog();
        return;
      }

      // 2. Nối tiếp video (lấy frame cuối cùng của video trước) hoặc Extend video (Veo Extension Lite)
      if (videoInfo?.mode === "video_continuation") {
        if (!videoInfo.sourceMediaId && !hasPendingUpstream) {
          useBoardStore.getState().updateNodeData(rfId, {
            extractError: isExtend
              ? "Video trước chưa có file để kéo dài."
              : "Video trước chưa có file để trích xuất frame cuối.",
          });
          return;
        }

        closeGenerationDialog();
        useBoardStore.getState().updateNodeData(rfId, { extractingFrame: false, extractError: null });

        if (isExtend) {
          dispatchGeneration(rfId, {
            prompt: videoPrompt,
            aspectRatio,
            kind: "video",
            cameraMode: camera,
            videoMode: "extend_video",
            sourceMediaId: videoInfo.sourceMediaId,
            variantCount: variants,
          });
          return;
        }

        dispatchGeneration(rfId, {
          prompt: videoPrompt,
          aspectRatio,
          kind: "video",
          cameraMode: camera,
          videoMode: "i2v",
          sourceVideoId: videoInfo.sourceMediaId,
          variantCount: 1,
        });
        return;
      }

      // 3. Ảnh -> Video (i2v hoặc r2v)
      if (isEffectiveR2v) {
        closeGenerationDialog();
        const sources = refSourceNodes.flatMap((r) => r.mediaId
          ? [{ mediaId: r.mediaId, isVideo: r.node.data.type === "video" }]
          : []);
        const sourceMediaIds = [
          ...sources.filter((source) => !source.isVideo).map((source) => source.mediaId),
          ...r2vAdditionalMediaIds,
        ];
        const sourceVideoIds = sources.filter((source) => source.isVideo).map((source) => source.mediaId);
        useBoardStore.getState().updateNodeGeneration(rfId, { r2vAdditionalMediaIds });
        useBoardStore.getState().updateNodeData(rfId, { extractingFrame: false, extractError: null });
        dispatchGeneration(rfId, {
          prompt: videoPrompt,
          aspectRatio,
          kind: "video",
          cameraMode: camera,
          videoMode: "r2v",
          sourceMediaIds,
          sourceVideoIds,
          variantCount: variants,
        });
        return;
      }

      // For i2v
      const finalPicked = sourceMediaIds.filter((_, i) => selectedSourceIdx.has(i));
      const useMulti = finalPicked.length > 1;

      if (videoInfo?.mode === "i2v") {
        useBoardStore.getState().updateNodeGeneration(rfId, { connectedVideoMode });
      }

      dispatchGeneration(rfId, {
        prompt: videoPrompt,
        aspectRatio,
        kind: "video",
        cameraMode: camera,
        videoMode: actualConnectedMode as "i2v" | "r2v",
        sourceMediaId: useMulti ? undefined : finalPicked[0],
        sourceMediaIds: useMulti ? finalPicked : undefined,
        variantCount: actualConnectedMode === "r2v" ? variants : (useMulti ? finalPicked.length * variants : variants),
      });
      closeGenerationDialog();
      return;
    } else {
      dispatchGeneration(rfId, {
        prompt: finalPrompt,
        aspectRatio,
        variantCount: variants,
        prompts: perVariantPrompts,
      });
      closeGenerationDialog();
      return;
    }
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
