import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../store/generation";
import { useBoardStore, type FlowNode, type StoryboardGrid } from "../store/board";
import {
  STORYBOARD_GRIDS,
  buildStoryboardPrompt,
  buildStoryboardVideoPrompt,
  normaliseStoryboardGrid,
  totalPanels,
} from "../lib/storyboardPrompt";
import {
  useSettingsStore,
  OMNI_FLASH_CREDIT_COST,
  OMNI_FLASH_DURATIONS,
  OMNI_FLASH_RESOLUTIONS,
  type ImageModelKey,
  type MediaProviderKey,
  type OmniFlashDuration,
  type OmniFlashResolution,
  type VideoModelFamily,
  type VideoQuality,
} from "../store/settings";
import {
  autoPrompt as autoPromptApi,
  autoPromptBatch as autoPromptBatchApi,
  mediaUrl,
  patchEdge,
  patchNode,
  uploadImage,
} from "../canvas/canvasApi";
import {
  getVideoUpstreamInfo,
  type VideoUpstreamInfo,
} from "../utils/videoFrame";
import {
  CHARACTER_GENDERS,
  CHARACTER_COUNTRIES,
  CHARACTER_VIBES,
  type GenderKey,
  type CountryKey,
  type VibeKey,
} from "../constants/character";
import { MediaPicker } from "./MediaPicker";
import type { MediaItem } from "../api/types";

const REF_SOURCE_TYPES = new Set([
  "character",
  "image",
  "visual_asset",
  // Storyboard outputs are first-class refs — they're composite images
  // that can feed downstream image / Omni-video / character nodes.
  "Storyboard",
  "video",
]);

type RefSourceEntry = {
  edgeId: string;
  node: FlowNode;
  // `undefined` = upstream node hasn't produced any media yet. Kept in the
  // list (rather than dropped) so it can surface as a pending notice.
  mediaId: string | undefined;
  variantIdx: number | null;
  allVariants: string[];
};

// Unified "source chưa sẵn sàng" messaging. Every downstream target (image,
// character, storyboard, i2v, r2v, video_continuation) shows the SAME
// warning box + wording when an upstream source hasn't produced media yet,
// so the user always knows exactly which node to go generate first.
function mediaNounFor(node: FlowNode): "ảnh" | "video" {
  return node.data.type === "video" ? "video" : "ảnh";
}

function pendingSourceMessage(node: FlowNode): string {
  const id = node.data.shortId || node.id;
  const noun = mediaNounFor(node);
  const status = node.data.status;
  if (status === "queued" || status === "running") {
    return `Node #${id} đang được tạo ${noun} — vui lòng chờ hoàn thành trước.`;
  }
  if (status === "done") {
    return `Node #${id} đã xong nhưng chưa có ${noun} file. Hãy tạo lại ${noun} trước khi gen node này.`;
  }
  return `Node #${id} chưa có ${noun} kết quả. Hãy tạo ${noun} trước khi gen node này.`;
}

function SourcePendingNotice({ nodes }: { nodes: FlowNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <div className="source-pending-notice" role="status">
      {nodes.map((n) => (
        <div key={n.id} className="source-pending-notice__item">
          ⚠ {pendingSourceMessage(n)}
        </div>
      ))}
    </div>
  );
}

function buildCharacterPrompt(
  gender: GenderKey | null,
  country: CountryKey | null,
  vibe: VibeKey,
  extras: string,
): string {
  const g = CHARACTER_GENDERS.find((x) => x.key === gender)?.tag;
  const c = CHARACTER_COUNTRIES.find((x) => x.key === country)?.tag;
  const subject = [c, g].filter(Boolean).join(" ") || "person";
  const vibeTokens = CHARACTER_VIBES.find((v) => v.key === vibe)?.tokens ?? [];
  const tail = extras.trim();
  // Pose anchor is front-loaded (right after subject) because diffusion
  // models weight earlier tokens more — vibe tokens like "editorial /
  // magazine beauty" otherwise pull toward fashion 3/4 turns. The trailing
  // negatives reinforce the lock so the headshot stays usable as a
  // character reference across every downstream shot.
  return [
    `Studio portrait headshot of a ${subject} character`,
    "subject directly faces the camera, head perfectly straight with zero tilt and zero turn",
    "shoulders square to camera, axially symmetric pose, nose centered, both eyes equally visible at the same height",
    ...vibeTokens,
    tail || null,
    "head and shoulders framing, centered composition, sharp focus on face",
    "strictly front-on orientation, no head tilt, no head turn, no profile angle, no three-quarter view, no over-the-shoulder pose",
    "no glasses, no hat, no mask, no occlusion, nothing covering the face",
    "photorealistic, ultra-detailed, consistent character reference",
  ]
    .filter(Boolean)
    .join(", ");
}

const IMAGE_ASPECT_RATIOS = [
  { key: "IMAGE_ASPECT_RATIO_SQUARE", label: "1:1" },
  { key: "IMAGE_ASPECT_RATIO_PORTRAIT", label: "9:16" },
  { key: "IMAGE_ASPECT_RATIO_LANDSCAPE", label: "16:9" },
] as const;

const VIDEO_ASPECT_RATIOS = [
  { key: "VIDEO_ASPECT_RATIO_LANDSCAPE", label: "16:9 landscape" },
  { key: "VIDEO_ASPECT_RATIO_PORTRAIT", label: "9:16 portrait" },
] as const;

// Camera movement presets for video.
// - `static` (default): locked-off, no zoom/pan — best for e-commerce
//   product showcase since it keeps the product fully framed.
// - `dynamic`: no camera constraint — the auto-prompt synthesiser is free
//   to suggest dolly / pan / etc. as it sees fit. Empty instruction → no
//   constraint string appended to the final prompt either.
const CAMERA_MOVEMENTS = [
  {
    key: "static",
    label: "Static",
    instruction:
      "Camera: locked-off static frame, no zoom and no pan. Keep the full "
      + "subject and any product clearly visible in the frame for the "
      + "entire clip. Background and crop must not change.",
  },
  {
    key: "dynamic",
    label: "Dynamic",
    instruction: "",
  },
] as const;

type CameraKey = (typeof CAMERA_MOVEMENTS)[number]["key"];

// Video model picker shown in the dialog — mirrors the unified list from
// SettingsPanel so the user can override the model per-dispatch without
// opening the gear menu. Selecting a chip mutates the global settings
// store (same pattern as the Omni-duration chips below), so the choice
// is sticky for subsequent dispatches.
// Each chip is either a Veo quality combo or Omni Flash. `ultraOnly`
// chips are locked when the detected paygate tier isn't TIER_TWO —
// the backend would silently fall back to Fast otherwise.
type VeoChip = {
  kind: "veo";
  quality: VideoQuality;
  label: string;
  ultraOnly: boolean;
};
type OmniChip = { kind: "omni"; label: string };
type VideoModelChip = VeoChip | OmniChip;

const VIDEO_MODEL_CHIPS: readonly VideoModelChip[] = [
  { kind: "veo", quality: "lite", label: "Veo 3.1 Lite", ultraOnly: false },
  { kind: "veo", quality: "fast", label: "Veo 3.1 Fast", ultraOnly: false },
  { kind: "veo", quality: "quality", label: "Veo 3.1 Quality", ultraOnly: false },
  { kind: "veo", quality: "lite_relaxed", label: "Veo 3.1 Lite (Low Priority)", ultraOnly: true },
  { kind: "omni", label: "Omni Flash" },
];

function cameraInstruction(key: CameraKey): string {
  return CAMERA_MOVEMENTS.find((c) => c.key === key)?.instruction ?? "";
}

type ImageAspectKey = (typeof IMAGE_ASPECT_RATIOS)[number]["key"];
type VideoAspectKey = (typeof VIDEO_ASPECT_RATIOS)[number]["key"];
type AspectKey = ImageAspectKey | VideoAspectKey;

// Map an upstream image aspect onto the closest video aspect. Square has
// no direct video equivalent — fall back to portrait per the
// "default-to-9:16 on mismatch" rule.
function imageAspectToVideo(img: string | undefined): VideoAspectKey | null {
  if (img === "IMAGE_ASPECT_RATIO_LANDSCAPE") return "VIDEO_ASPECT_RATIO_LANDSCAPE";
  if (img === "IMAGE_ASPECT_RATIO_PORTRAIT") return "VIDEO_ASPECT_RATIO_PORTRAIT";
  if (img === "IMAGE_ASPECT_RATIO_SQUARE") return "VIDEO_ASPECT_RATIO_PORTRAIT";
  return null;
}

// Walk upstream of the target node, collect each upstream's aspectRatio,
// then apply the user's rule:
//   • single distinct aspect → match it
//   • multiple distinct aspects → fall back to 9:16
//   • zero upstream / unknown → caller's default
function pickDefaultAspect(
  rfId: string,
  targetType: string,
  nodes: ReturnType<typeof useBoardStore.getState>["nodes"],
  edges: ReturnType<typeof useBoardStore.getState>["edges"],
): AspectKey | null {
  const upstreamAspects: string[] = [];
  for (const e of edges) {
    if (e.target !== rfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    const ar = src.data.aspectRatio;
    if (typeof ar === "string" && ar.length > 0) upstreamAspects.push(ar);
  }
  if (upstreamAspects.length === 0) return null;

  if (targetType === "video") {
    const mapped = upstreamAspects
      .map(imageAspectToVideo)
      .filter((x): x is VideoAspectKey => x !== null);
    if (mapped.length === 0) return null;
    const unique = new Set(mapped);
    if (unique.size === 1) return mapped[0];
    return "VIDEO_ASPECT_RATIO_PORTRAIT";
  }
  // Image (and character — though character has its own opinionated
  // default; the caller short-circuits before reaching here).
  const validImg = upstreamAspects.filter((a): a is ImageAspectKey =>
    IMAGE_ASPECT_RATIOS.some((p) => p.key === a),
  );
  if (validImg.length === 0) return null;
  const unique = new Set(validImg);
  if (unique.size === 1) return validImg[0];
  return "IMAGE_ASPECT_RATIO_PORTRAIT";
}

// Small "ⓘ" affordance for moving static help-text out of the layout
// into a hover tooltip — keeps the dialog short while preserving the
// information for users who want it. Native `title` (plain text) is
// enough; we don't need rich markup in tooltips.
function InfoTip({ tip }: { tip: string }) {
  return (
    <span
      className="gen-dialog__info-tip"
      title={tip}
      aria-label={tip}
      role="img"
    >
      ⓘ
    </span>
  );
}

type GenerationFormState = {
  prompt: string;
  aspectRatio: string;
  variants: number;
  camera: CameraKey;
  storyboardGrid: StoryboardGrid;
  charGender: GenderKey | null;
  charCountry: CountryKey | null;
  charVibe: VibeKey;
  charExtras: string;
  selectedSourceIdx: number[];
  t2vLibraryMediaId: string | null;
  t2vLibraryMediaItem: MediaItem | null;
  independentVideoMediaIds: string[];
  independentVideoMode: "i2v" | "r2v";
  connectedVideoMode: "i2v" | "r2v";
  /** Only relevant when upstream is a single Veo video node (video_continuation context).
   *  "continuation" = extract last frame (existing behaviour).
   *  "extend" = call fZytfe Veo Extension Lite. */
  videoExtendMode: "continuation" | "extend";
  r2vAdditionalMediaIds: string[];
  omniVideoMode?: "default" | "video_reference";
  videoReferenceMediaId?: string | null;
  backend: MediaProviderKey;
  imageModel: ImageModelKey;
  videoModel: VideoModelFamily;
  videoQuality: VideoQuality;
  omniFlashDuration: OmniFlashDuration;
  omniFlashResolution: OmniFlashResolution;
};

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
  const triggerRef = useRef<Element | null>(null);
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

  // A standalone video node remains structurally t2v in the graph, but
  // picking library images changes the effective generation mode.
  const independentVideoEffectiveMode: "t2v" | "i2v" | "r2v" | "video_reference" =
    isOmniVideo && omniVideoMode === "video_reference"
      ? "video_reference"
      : independentVideoMediaIds.length > 1
        ? "r2v"
        : independentVideoMediaIds.length === 1
          ? independentVideoMode
          : "t2v";
  const independentVideoModeLabel =
    independentVideoEffectiveMode === "video_reference"
      ? "Video Reference (jIps6)"
      : independentVideoEffectiveMode === "t2v"
        ? "Text → Video (t2v)"
        : independentVideoEffectiveMode === "i2v"
          ? "Image → Video (i2v)"
          : "Ingredients (r2v)";

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
  const actualConnectedMode = videoInfo?.mode === "i2v" 
    ? (totalConnectedSources >= 2 ? "r2v" : connectedVideoMode) 
    : videoInfo?.mode;
  const isEffectiveR2v = isVideo && (
    (videoInfo?.mode === "i2v" || videoInfo?.mode === "r2v") && actualConnectedMode === "r2v"
  );
  const isUpstreamVeoVideo = videoInfo?.mode === "video_continuation" && videoInfo.sourceNodeFamily === "veo";
  const isExtend = isUpstreamVeoVideo && videoExtendMode === "extend";
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
        (savedForm as any).videoExtendMode === "extend" ? "extend" : "continuation",
      );
      setR2vAdditionalMediaIds(
        savedForm.r2vAdditionalMediaIds ?? [],
      );

      const storedVideoRef = (savedGeneration.videoReference as any)?.sourceMediaId
        ?? (savedForm as any).videoReferenceMediaId
        ?? (typeof (savedGeneration as any).sourceMediaId === "string" ? (savedGeneration as any).sourceMediaId : null);
      setVideoReferenceMediaId(typeof storedVideoRef === "string" ? storedVideoRef : null);

      const isVideoRefMode = savedGeneration.videoMode === "video_reference"
        || (savedForm as any).omniVideoMode === "video_reference";
      setOmniVideoMode(isVideoRefMode ? "video_reference" : "default");
      setUploadVideoError(null);
      setUploadingVideo(false);
      
      triggerRef.current = document.activeElement;
      // Focus textarea on open
      setTimeout(() => firstFocusRef.current?.focus(), 50);
    } else {
      // Return focus on close
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
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

  // Keyboard handling
  useEffect(() => {
    if (rfId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // ESC closes the variant picker first if open, otherwise the
        // dialog. Lets the user back out of a stray picker click
        // without losing their prompt + form state.
        if (openVariantPicker !== null) {
          e.preventDefault();
          setOpenVariantPicker(null);
          return;
        }
        e.preventDefault();
        closeGenerationDialog();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // Click-outside to close the variant picker. We listen on
  // `mousedown` instead of `click` so the close fires BEFORE the chip's
  // `onClick` toggle would otherwise re-open it on the same gesture.
  // A click that lands inside any `.ref-source-chip-wrap` is ignored —
  // chip-internal handlers (toggle / swap / pick) own those.
  useEffect(() => {
    if (openVariantPicker === null) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".ref-source-chip-wrap")) return;
      setOpenVariantPicker(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [openVariantPicker]);

  // Focus trap
  useEffect(() => {
    if (rfId === null) return;
    const el = dialogRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = el.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [rfId]);

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
  const isVideoReady =
    !isVideo ||
    (isOmniVideo && omniVideoMode === "video_reference"
      ? (Boolean(videoReferenceMediaId) || (videoInfo?.mode === "video_continuation" && (Boolean(videoInfo.sourceMediaId) || hasPendingUpstream))) && !extractingFrame
      : videoInfo?.mode === "t2v"
      ? (isOmniVideo ? independentVideoMediaIds.length > 0 : (prompt.trim().length > 0 || independentVideoMediaIds.length > 0)) && !extractingFrame
      : videoInfo?.mode === "video_continuation"
      ? (Boolean(videoInfo.sourceMediaId) || hasPendingUpstream) &&
        (videoInfo.sourceNode?.data.status === "done" || hasPendingUpstream) &&
        (isExtend ? true : !extractingFrame)
      : (isEffectiveR2v
          ? (refSourceNodes.length > 0 || r2vAdditionalMediaIds.length > 0 || hasPendingUpstream)
          : (selectedSourceIdx.size > 0 || hasPendingUpstream)) && !extractingFrame);

  // FIX(bug 2): Keep character generation disabled while any work is running.
  const canGenerate = isCharacter
    ? (charGender !== null || charCountry !== null || charExtras.trim().length > 0) && !isWorking
    : isVideo
    ? isVideoReady && !isWorking
    : !isWorking;

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
                ? (isOmniVideo && omniVideoMode === "video_reference")
                  ? "Tham chiếu video (Omni Flash - jIps6)"
                  : videoInfo?.mode === "t2v"
                  ? independentVideoEffectiveMode === "t2v"
                    ? "Tạo video từ Text (t2v)"
                    : independentVideoEffectiveMode === "i2v"
                      ? "Tạo video từ Ảnh (i2v)"
                      : "Tạo video từ Ingredients (r2v)"
                  : videoInfo?.mode === "video_continuation"
                  ? isExtend
                    ? "Kéo dài video (Extend Video)"
                    : "Nối tiếp video (Frame cuối)"
                  : "Tạo video từ Ảnh (i2v)"
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
                <span className={`gen-dialog__mode-badge gen-dialog__mode-badge--${isOmniVideo && omniVideoMode === "video_reference" ? "video_reference" : (videoInfo.mode === "t2v" ? independentVideoEffectiveMode : (isExtend ? "extend" : videoInfo.mode))}`}>
                  {isOmniVideo && omniVideoMode === "video_reference" ? "Tham chiếu video (Omni Flash)" : (videoInfo.mode === "t2v" ? independentVideoModeLabel : (isExtend ? "Extend video (Veo)" : videoInfo.label))}
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

        {/* Prompt */}
        <div className="gen-dialog__field">
            <div className="gen-dialog__label-row">
              <label className="gen-dialog__label" htmlFor="gen-prompt">
                {isVideo ? "Motion prompt" : "Prompt"}
                {autoPromptUsed && (
                  <span className="gen-dialog__auto-badge" title="Auto-generated from upstream nodes">
                    ✨ auto
                  </span>
                )}
              </label>
              <span className="gen-dialog__char-count">{prompt.length}/500</span>
            </div>
            <textarea
              id="gen-prompt"
              ref={firstFocusRef}
              className="gen-dialog__textarea"
              rows={5}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (autoPromptUsed) setAutoPromptUsed(false);
              }}
              placeholder={
                isVideo
                  ? (isOmniVideo && omniVideoMode === "video_reference")
                    ? "Mô tả chỉnh sửa video theo video tham chiếu (vd: đổi nhân vật trong video, đổi trang phục, bối cảnh)…"
                    : videoInfo?.mode === "t2v"
                    ? independentVideoEffectiveMode === "t2v"
                      ? "Nhập mô tả video cần tạo (Text to Video)…"
                      : independentVideoEffectiveMode === "i2v"
                        ? "Bỏ trống để tự sinh motion prompt từ source image ✨ hoặc nhập prompt…"
                        : "Bỏ trống để tự sinh motion prompt từ các source images ✨ hoặc nhập prompt…"
                    : videoInfo?.mode === "video_continuation"
                    ? isExtend
                      ? "Nhập mô tả diễn biến tiếp theo để kéo dài video (Veo Extension)…"
                      : "Nhập mô tả diễn biến tiếp theo sau frame cuối của video trước…"
                    : "Bỏ trống để tự sinh motion prompt từ source image ✨ hoặc nhập prompt…"
                  : isPrompt
                  ? "Nhập prompt mồi để feed cho downstream image / video…"
                  : "Bỏ trống để tự generate prompt từ upstream nodes ✨"
              }
              disabled={isWorking || extractingFrame}
              readOnly={hasStoryboardUpstream}
              title={
                hasStoryboardUpstream
                  ? "Locked: storyboard motion template (animates panels in order)"
                  : undefined
              }
            />
            {extractingFrame && (
              <p className="gen-dialog__hint" style={{ color: "var(--accent)" }}>
                ⏳ Đang trích xuất frame cuối từ video trước và tải lên Flow…
              </p>
            )}
            {extractError && (
              <p className="gen-dialog__hint" style={{ color: "#ef4444" }}>
                ⚠ {extractError}
              </p>
            )}
            {hasStoryboardUpstream && (
              <p className="gen-dialog__hint gen-dialog__hint--locked">
                🎬 <strong>Storyboard motion template</strong> — locked because an
                upstream Storyboard node is feeding this video. Flow animates
                the composite panels in order (frame 1 →
                {" "}{totalPanels(storyboardUpstreamGrid)}). Other refs
                (character / location / visual_asset) still flow through normally.
              </p>
            )}
            {isWorking && (
              <p className="gen-dialog__hint">
                {node?.data.aiBriefStatus === "pending"
                  ? "✨ Đang phân tích image…"
                  : "✨ Đang dựng prompt từ upstream context…"}
              </p>
            )}
        </div>

        {/* Character builder (character node only) */}
        {isCharacter && (
          <>
            <div className="gen-dialog__field">
              <span className="gen-dialog__label">Gender</span>
              <div className="aspect-chip-row">
                {CHARACTER_GENDERS.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    disabled={isWorking}
                    className={`aspect-chip${charGender === g.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharGender(charGender === g.key ? null : g.key)}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <span className="gen-dialog__label">Quốc gia</span>
              <div className="aspect-chip-row">
                {CHARACTER_COUNTRIES.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    disabled={isWorking}
                    className={`aspect-chip${charCountry === c.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharCountry(charCountry === c.key ? null : c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <span className="gen-dialog__label">Vibe</span>
              <div className="aspect-chip-row">
                {CHARACTER_VIBES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    disabled={isWorking}
                    className={`aspect-chip${charVibe === v.key ? " aspect-chip--active" : ""}`}
                    onClick={() => setCharVibe(v.key)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="gen-dialog__field">
              <div className="gen-dialog__label-row">
                <label className="gen-dialog__label" htmlFor="gen-char-extras">
                  Mô tả thêm (tuỳ chọn)
                  <InfoTip tip="Prompt được auto-build: portrait headshot · vibe styling · photorealistic — tối ưu cho character reference." />
                </label>
                <span className="gen-dialog__char-count">{charExtras.length}/200</span>
              </div>
              {/* FIX(bug 5): Leave the initial focus target on the main prompt only. */}
              <textarea
                id="gen-char-extras"
                className="gen-dialog__textarea"
                rows={3}
                value={charExtras}
                disabled={isWorking}
                onChange={(e) => setCharExtras(e.target.value)}
                placeholder="Tuổi, kiểu tóc, trang phục, biểu cảm…"
              />
            </div>
          </>
        )}

        {/* Source image / video source info (t2v, continuation, or i2v) */}
        {isVideo && videoInfo?.mode === "t2v" && (
          <div className="gen-dialog__field">
            {isOmniVideo && omniVideoMode === "video_reference" ? (
              <div className="source-info-box source-info-box--continuation">
                <div className="source-info-box__header">
                  <span className="source-info-box__icon">🎥</span>
                  <div className="source-info-box__content" style={{ width: '100%' }}>
                    <div className="gen-dialog__label-row" style={{ alignItems: 'center' }}>
                      <span className="source-info-box__title">Chế độ: Tham chiếu video</span>
                      <select
                        className="source-select-mini"
                        value={omniVideoMode}
                        onChange={(e) => setOmniVideoMode(e.target.value as "default" | "video_reference")}
                        disabled={isWorking}
                        style={{ padding: '2px 8px', borderRadius: '4px', background: '#333', color: '#fff', border: 'none' }}
                      >
                        <option value="default">Ảnh / Text (T2V/I2V/R2V)</option>
                        <option value="video_reference">Tham chiếu video</option>
                      </select>
                    </div>
                    <p className="source-info-box__desc">
                      Chỉ tham chiếu duy nhất 1 video. Bạn có thể chọn video trong project hoặc tải tệp video lên.
                    </p>
                  </div>
                </div>

                {uploadVideoError && (
                  <p className="node-error" style={{ margin: '8px 0 0' }}>{uploadVideoError}</p>
                )}

                {videoReferenceMediaId ? (
                  <div className="source-continuation-preview" style={{ marginTop: 10 }}>
                    <video
                      src={mediaUrl(videoReferenceMediaId)}
                      className="source-continuation-video"
                      controls
                      muted
                      preload="metadata"
                      style={{ maxHeight: 180, width: '100%', borderRadius: 6 }}
                    />
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                      <span className="source-continuation-tag" style={{ color: '#22d3ee' }}>
                        ✓ Đang tham chiếu video này
                      </span>
                      <MediaPicker
                        kind="video"
                        workspaceId={boardPublicId}
                        multi={false}
                        value={videoReferenceMediaId}
                        buttonText="Đổi video"
                        disabled={isWorking || uploadingVideo}
                        onChange={(val) => {
                          const id = Array.isArray(val) ? val[0] : val;
                          setVideoReferenceMediaId(id || null);
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={isWorking || uploadingVideo}
                        onClick={() => videoFileInputRef.current?.click()}
                      >
                        {uploadingVideo ? "Đang tải…" : "⬆ Tải video khác"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.4)' }}
                        disabled={isWorking || uploadingVideo}
                        onClick={() => setVideoReferenceMediaId(null)}
                      >
                        ✕ Xóa
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: 12, display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <MediaPicker
                      kind="video"
                      workspaceId={boardPublicId}
                      multi={false}
                      value={null}
                      buttonText="📁 Chọn video trong project"
                      disabled={isWorking || uploadingVideo}
                      onChange={(val) => {
                        const id = Array.isArray(val) ? val[0] : val;
                        setVideoReferenceMediaId(id || null);
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={isWorking || uploadingVideo}
                      onClick={() => videoFileInputRef.current?.click()}
                    >
                      {uploadingVideo ? "Đang tải…" : "⬆ Tải video lên"}
                    </button>
                  </div>
                )}

                <input
                  ref={videoFileInputRef}
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      await handleUploadVideoFile(file);
                      e.target.value = '';
                    }
                  }}
                />

                <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <div className="gen-dialog__label-row">
                    <span className="gen-dialog__label">Ảnh tham chiếu kèm theo (tuỳ chọn - Ingredients):</span>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <MediaPicker
                      kind="image"
                      workspaceId={boardPublicId}
                      multi={true}
                      value={r2vAdditionalMediaIds}
                      disabled={isWorking}
                      onChange={(ids) => {
                        const newIds = Array.isArray(ids) ? ids : (ids ? [ids] : []);
                        setR2vAdditionalMediaIds(newIds);
                      }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="source-info-box source-info-box--t2v">
                <span className="source-info-box__icon">✨</span>
                <div className="source-info-box__content" style={{ width: '100%' }}>
                  <div className="gen-dialog__label-row">
                    <span className="source-info-box__title">Chế độ: Text/Image to Video</span>
                    {isOmniVideo && (
                      <select
                        className="source-select-mini"
                        value={omniVideoMode}
                        onChange={(e) => setOmniVideoMode(e.target.value as "default" | "video_reference")}
                        disabled={isWorking}
                        style={{ padding: '2px 8px', borderRadius: '4px', background: '#333', color: '#fff', border: 'none' }}
                      >
                        <option value="default">Ảnh / Text (T2V/I2V/R2V)</option>
                        <option value="video_reference">Tham chiếu video</option>
                      </select>
                    )}
                    {independentVideoMediaIds.length === 1 && !isOmniVideo && (
                      <select
                        className="source-select-mini"
                        value={independentVideoMode}
                        onChange={(e) => persistIndependentVideoMode(e.target.value as "i2v" | "r2v")}
                        disabled={isWorking}
                        style={{ padding: '2px 8px', borderRadius: '4px', background: '#333', color: '#fff', border: 'none' }}
                      >
                        <option value="i2v">Nối tiếp (i2v)</option>
                        <option value="r2v">Ingredients (r2v)</option>
                      </select>
                    )}
                    {independentVideoMediaIds.length > 1 && !isOmniVideo && (
                      <span className="source-select-mini" style={{ padding: '2px 8px', borderRadius: '4px', background: '#333', color: '#fb923c', border: 'none', display: 'inline-block' }}>
                        Ingredients (r2v)
                      </span>
                    )}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <MediaPicker
                      kind="image"
                      workspaceId={boardPublicId}
                      multi={true}
                      value={independentVideoMediaIds}
                      disabled={isWorking}
                      onChange={(ids) => {
                        const newIds = Array.isArray(ids) ? ids : (ids ? [ids] : []);
                        persistIndependentVideoSelection(newIds);
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {isVideo && videoInfo?.mode !== "t2v" && (
          <div className="gen-dialog__field">

            {videoInfo?.mode === "video_continuation" && (
              <div className="source-info-box source-info-box--continuation">
                <div className="source-info-box__header">
                  <span className="source-info-box__icon">🎬</span>
                  <div className="source-info-box__content" style={{ width: '100%' }}>
                    <div className="gen-dialog__label-row" style={{ alignItems: 'center' }}>
                      <span className="source-info-box__title">
                        {isExtend
                          ? `Kéo dài Video #${videoInfo.sourceNode?.data.shortId}`
                          : (isOmniVideo && omniVideoMode === "video_reference"
                              ? `Tham chiếu Video #${videoInfo.sourceNode?.data.shortId}`
                              : `Nối tiếp Video #${videoInfo.sourceNode?.data.shortId}`)}
                      </span>
                      {isUpstreamVeoVideo && (
                        <select
                          className="source-select-mini"
                          value={videoExtendMode}
                          onChange={(e) => setVideoExtendMode(e.target.value as "continuation" | "extend")}
                          disabled={isWorking}
                          style={{ padding: '2px 8px', borderRadius: '4px', background: '#333', color: '#fff', border: 'none' }}
                        >
                          <option value="continuation">Nối tiếp (Frame cuối)</option>
                          <option value="extend">Kéo dài (Extend video)</option>
                        </select>
                      )}
                      {isOmniVideo && (
                        <select
                          className="source-select-mini"
                          value={omniVideoMode}
                          onChange={(e) => setOmniVideoMode(e.target.value as "default" | "video_reference")}
                          disabled={isWorking}
                          style={{ padding: '2px 8px', borderRadius: '4px', background: '#333', color: '#fff', border: 'none' }}
                        >
                          <option value="default">Nối tiếp (Frame cuối)</option>
                          <option value="video_reference">Tham chiếu video này</option>
                        </select>
                      )}
                    </div>
                    <p className="source-info-box__desc">
                      {isExtend
                        ? "Kéo dài video trực tiếp bằng Veo Extension Lite (fZytfe). Giữ liền mạch bối cảnh và chuyển động của video gốc."
                        : (isOmniVideo && omniVideoMode === "video_reference"
                            ? "Sử dụng video của node trước làm video tham chiếu trực tiếp cho Omni Flash (jIps6)."
                            : "Frame cuối cùng của video trước sẽ được tự động trích xuất làm điểm bắt đầu (start frame) cho video này.")}
                    </p>
                  </div>
                </div>
                {videoInfo.sourceNode?.data.status !== "done" || !videoInfo.sourceMediaId ? (
                  <SourcePendingNotice
                    nodes={videoInfo.sourceNode ? [videoInfo.sourceNode] : []}
                  />
                ) : (
                  <div className="source-continuation-preview">
                    <video
                      src={mediaUrl(videoInfo.sourceMediaId)}
                      className="source-continuation-video"
                      controls
                      muted
                      preload="metadata"
                    />
                    <span className="source-continuation-tag">
                      {isExtend
                        ? "✓ Sẵn sàng extend video (Veo 3.1 Extension Lite)"
                        : (isOmniVideo && omniVideoMode === "video_reference"
                            ? "✓ Sẵn sàng tham chiếu video (Omni Flash jIps6)"
                            : "✓ Sẵn sàng trích xuất frame cuối khi bấm Generate")}
                    </span>
                  </div>
                )}
              </div>
            )}

            {(videoInfo?.mode === "i2v" || videoInfo?.mode === "r2v") && (
              <>
                <div className="gen-dialog__label-row">
                  <span className="gen-dialog__label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    Chế độ:
                    {videoInfo?.mode === "i2v" && totalConnectedSources <= 1 ? (
                      <select
                        className="source-select-mini"
                        value={connectedVideoMode}
                        onChange={(e) => setConnectedVideoMode(e.target.value as "i2v" | "r2v")}
                        disabled={isWorking}
                        style={{ padding: '2px 8px', borderRadius: '4px', background: '#333', color: '#fff', border: 'none' }}
                      >
                        <option value="i2v">Nối tiếp (i2v)</option>
                        <option value="r2v">Ingredients (r2v)</option>
                      </select>
                    ) : (
                      <span className="source-select-mini" style={{ padding: '2px 8px', borderRadius: '4px', background: '#333', color: '#fb923c', border: 'none', display: 'inline-block' }}>
                        Ingredients (r2v)
                      </span>
                    )}
                  </span>
                </div>
                
                {actualConnectedMode === "i2v" && (
                  <>
                    <div className="gen-dialog__label-row" style={{ marginTop: '10px' }}>
                      <span className="gen-dialog__label">
                        Source image{sourceMediaIds.length > 1 ? `s (${sourceMediaIds.length})` : ""}
                      </span>
                      {sourceMediaIds.length > 1 && (
                        <div className="source-select-actions">
                          <button
                            type="button"
                            className="source-select-mini"
                            onClick={() =>
                              setSelectedSourceIdx(
                                new Set(sourceMediaIds.map((_, i) => i)),
                              )
                            }
                          >
                            All
                          </button>
                          <button
                            type="button"
                            className="source-select-mini"
                            onClick={() => setSelectedSourceIdx(new Set())}
                          >
                            None
                          </button>
                        </div>
                      )}
                    </div>
                {sourceMediaIds.length > 0 && sourceNode ? (
                  <>
                    <div className="source-image-row">
                      {sourceMediaIds.map((mid, i) => {
                        const checked = selectedSourceIdx.has(i);
                        return (
                          <button
                            key={mid}
                            type="button"
                            disabled={isWorking}
                            className={`source-thumb${checked ? " source-thumb--checked" : ""}`}
                            onClick={() => {
                              setSelectedSourceIdx((prev) => {
                                const next = new Set(prev);
                                if (next.has(i)) next.delete(i);
                                else next.add(i);
                                return next;
                              });
                            }}
                            aria-pressed={checked}
                            aria-label={`Variant ${i + 1}${checked ? " selected" : ""}`}
                          >
                            <img
                              className="source-image-row__thumb"
                              src={mediaUrl(mid)}
                              alt={sourceNode.data.title}
                            />
                            <span className="source-thumb__check" aria-hidden="true">
                              {checked ? "✓" : ""}
                            </span>
                          </button>
                        );
                      })}
                      <span className="source-image-row__label">
                        #{sourceNode.data.shortId}
                      </span>
                    </div>
                    <p className="gen-dialog__hint">
                      {selectedSourceIdx.size === 0 ? (
                        <span style={{ color: "#ef4444" }}>
                          Chọn ít nhất 1 variant để gen video.
                        </span>
                      ) : (
                        <>
                          Sẽ gen <strong>{selectedSourceIdx.size} video</strong>
                          {selectedSourceIdx.size === sourceMediaIds.length
                            ? " (tất cả variants)"
                            : ` (${selectedSourceIdx.size}/${sourceMediaIds.length} variants)`}
                          — cùng prompt + camera setting.
                        </>
                      )}
                    </p>
                  </>
                ) : (
                  <SourcePendingNotice
                    nodes={sourceNode ? [sourceNode] : []}
                  />
                )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Source references — image refs (character/image/visual_asset/
            Storyboard) AND prompt-text refs. Prompt nodes don't have
            media but their text feeds the auto-prompt synth, so we
            surface them as text chips next to the thumbnails.
            Upstream nodes that haven't produced media yet still appear
            here — as the unified ⚠ pending notice — so a never/partially
            generated source is never silently invisible. */}
        {(!isVideo || isEffectiveR2v)
          && (refSourceNodes.length > 0 || promptSourceNodes.length > 0 || pendingRefNodes.length > 0)
          && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Source references ({refSourceNodes.length + promptSourceNodes.length + pendingRefNodes.length})
            </span>
            <div className="ref-source-row">
              {promptSourceNodes.map((p) => {
                const preview = p.text.trim() || "(empty prompt)";
                return (
                  <div
                    key={p.edgeId}
                    className="ref-source-chip ref-source-chip--prompt"
                    title={`${p.node.data.title || "Prompt"} — ${preview}`}
                  >
                    <div className="ref-source-chip__prompt-body">
                      <span className="ref-source-chip__prompt-icon" aria-hidden="true">✦</span>
                      <span className="ref-source-chip__prompt-text">
                        {preview}
                      </span>
                    </div>
                    <span className="ref-source-chip__id">
                      #{p.node.data.shortId}
                    </span>
                  </div>
                );
              })}
              {refSourceNodes.map((r) => {
                const isMulti = r.allVariants.length >= 2;
                const isPickerOpen = openVariantPicker === r.edgeId;
                const tooltip = isMulti
                  ? `${r.node.data.title} — variant ${(r.variantIdx ?? 0) + 1} · click to switch`
                  : r.node.data.title;
                return (
                  <div key={r.edgeId} className="ref-source-chip-wrap">
                    {isMulti ? (
                      <button
                        type="button"
                        className={`ref-source-chip ref-source-chip--switchable${
                          isPickerOpen ? " ref-source-chip--active" : ""
                        }`}
                        title={tooltip}
                        onClick={() =>
                          setOpenVariantPicker(isPickerOpen ? null : r.edgeId)
                        }
                      >
                        {r.node.data.type === "video" ? (
                          <video className="ref-source-chip__img" src={mediaUrl(r.mediaId)} muted />
                        ) : (
                          <img
                            className="ref-source-chip__img"
                            src={mediaUrl(r.mediaId)}
                            alt={r.node.data.title}
                          />
                        )}
                        <span className="ref-source-chip__variant">
                          v{(r.variantIdx ?? 0) + 1}
                        </span>
                        <span className="ref-source-chip__id">
                          #{r.node.data.shortId}
                        </span>
                      </button>
                    ) : (
                      <div className="ref-source-chip" title={tooltip}>
                        {r.node.data.type === "video" ? (
                          <video className="ref-source-chip__img" src={mediaUrl(r.mediaId)} muted />
                        ) : (
                          <img
                            className="ref-source-chip__img"
                            src={mediaUrl(r.mediaId)}
                            alt={r.node.data.title}
                          />
                        )}
                        <span className="ref-source-chip__id">
                          #{r.node.data.shortId}
                        </span>
                      </div>
                    )}
                    {isMulti && isPickerOpen && (
                      <div
                        className="ref-source-chip__picker"
                        role="dialog"
                        aria-label={`Pick variant for ${r.node.data.title}`}
                      >
                        {r.allVariants.map((mid, i) => {
                          const isCurrent = i === (r.variantIdx ?? 0);
                          return (
                            <button
                              key={mid}
                              type="button"
                              className={`ref-source-chip__picker-item${
                                isCurrent ? " ref-source-chip__picker-item--current" : ""
                              }`}
                              onClick={() => void pickVariantForEdge(r.edgeId, i)}
                              title={`Variant ${i + 1}`}
                              aria-current={isCurrent ? "true" : undefined}
                            >
                              {r.node.data.type === "video" ? (
                                <video className="ref-source-chip__picker-img" src={mediaUrl(mid)} muted />
                              ) : (
                                <img
                                  className="ref-source-chip__picker-img"
                                  src={mediaUrl(mid)}
                                  alt={`Variant ${i + 1}`}
                                />
                              )}
                              <span className="ref-source-chip__picker-label">
                                v{i + 1}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {isEffectiveR2v && (
                <MediaPicker
                  kind="image"
                  workspaceId={boardPublicId}
                  multi={true}
                  value={r2vAdditionalMediaIds}
                  disabled={isWorking}
                  onChange={(ids) => {
                    const newIds = Array.isArray(ids) ? ids : (ids ? [ids] : []);
                    setR2vAdditionalMediaIds(newIds);
                  }}
                  buttonText="+ Thêm ảnh"
                />
              )}
            </div>
            {/* Upstream refs still generating / never generated — same
                unified notice the video sources use. */}
            <SourcePendingNotice nodes={pendingRefNodes} />
          </div>
        )}

        {/* Backend — which engine renders this dispatch. Sticky across
            dialogs (settings store). Muse = muse2api gateway, or a
            Pax worker via the provider-job queue; no Flow plan or
            extension needed. */}
        {!isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Backend
              <InfoTip tip="Flow = Chrome extension → Google Flow (cần Flow plan). Muse = muse2api gateway (hoặc Pax worker) tự render, không cần Flow plan hay extension — cần cấu hình muse2api hoặc có worker đang chạy (xem hướng dẫn ở AI Providers → Muse)." />
            </span>
            <div className="aspect-chip-row">
              <button
                key="flow"
                type="button"
                className={`aspect-chip${mediaProvider === "flow" ? " aspect-chip--active" : ""}`} disabled={isWorking}
                onClick={() => setMediaProvider("flow")}
              >
                Flow
              </button>
              {/* <button
                key="muse"
                type="button"
                className={`aspect-chip${mediaProvider === "muse" ? " aspect-chip--active" : ""}`} disabled={isWorking}
                onClick={() => setMediaProvider("muse")}
              >
                Muse
              </button> */}
            </div>
          </div>
        )}

        {/* Aspect ratio — irrelevant for prompt nodes (text-only). */}
        {!isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">Aspect ratio</span>
            <div className="aspect-chip-row">
              {(isVideo ? VIDEO_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS).map((ar) => (
                <button
                  key={ar.key}
                  className={`aspect-chip${aspectRatio === ar.key ? " aspect-chip--active" : ""}`}
                  onClick={() => setAspectRatio(ar.key)}
                  type="button"
                  disabled={isWorking}
                >
                  {ar.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Model picker comes first so selecting Omni reveals its options
            directly below. */}
        {isVideo && isExtend ? (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Model
              <InfoTip tip="Veo 3.1 Extension Lite (fZytfe): Model chuyên dụng của Flow để kéo dài video clip đã có." />
            </span>
            <div style={{ padding: '8px 12px', background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '6px', fontSize: '13px', color: '#fff' }}>
              Veo 3.1 Extension Lite (fZytfe)
            </div>
          </div>
        ) : isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Model
              <InfoTip tip="Sticky — selection được lưu cho các lần dispatch sau (đồng bộ với Settings). Veo dùng i2v (1 source image); Omni Flash dùng ingredients từ ảnh và video đầu vào." />
            </span>
            <select
              className="gen-dialog__select"
              disabled={isWorking}
              value={videoModelFamily === "omni_flash" ? "omni" : `veo:${videoQuality}`}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "omni") {
                  setVideoModel("omni_flash");
                  return;
                }
                const [, quality] = v.split(":") as ["veo", VideoQuality];
                setVideoModel("veo");
                setVideoQuality(quality);
              }}
            >
              {VIDEO_MODEL_CHIPS.map((m) => {
                if (m.kind === "omni") {
                  return <option key="omni" value="omni">Omni Flash</option>;
                }
                const locked = m.ultraOnly && paygateTier !== "PAYGATE_TIER_TWO";
                return (
                  <option key={`veo:${m.quality}`} value={`veo:${m.quality}`} disabled={locked}>
                    {m.label}{m.ultraOnly ? " · Ultra only" : ""}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {/* Omni Flash options are visible only while Omni is selected. */}
        {/* Omni Flash duration picker — video only, when the user's
            settings select the Omni model family. Replaces the implicit
            ~8s Veo duration with a per-dispatch radio. Credit cost is
            surfaced beside each option. */}
        {isOmniVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Resolution (Omni Flash)
              <InfoTip tip="Chọn độ phân giải cho Omni Flash. 720p cho chất lượng cao hơn; 360p có chi phí thấp hơn." />
            </span>
            <div className="aspect-chip-row">
              {OMNI_FLASH_RESOLUTIONS.map((resolution) => (
                <button
                  key={resolution}
                  type="button"
                  className={`aspect-chip${omniFlashResolution === resolution ? " aspect-chip--active" : ""}`}
                  disabled={isWorking}
                  onClick={() => setOmniFlashResolution(resolution as OmniFlashResolution)}
                >
                  {resolution}
                </button>
              ))}
            </div>
          </div>
        )}

        {isOmniVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Duration (Omni Flash)
              <InfoTip tip="Omni Flash dispatches via video:batchAsyncGenerateVideoReferenceImages with the upstream image(s) as IMAGE_USAGE_TYPE_ASSET refs. Duration scales credit cost: 4s=15, 6s=20, 8s=25, 10s=30." />
            </span>
            <div className="aspect-chip-row">
              {OMNI_FLASH_DURATIONS.map((d) => {
                const active = omniFlashDuration === d;
                return (
                  <button
                    key={d}
                    type="button"
                    className={`aspect-chip${active ? " aspect-chip--active" : ""}`} disabled={isWorking}
                    onClick={() =>
                      setOmniFlashDuration(d as OmniFlashDuration)
                    }
                    title={`${d}s — ${OMNI_FLASH_CREDIT_COST[d]} credits`}
                  >
                    {d}s · {OMNI_FLASH_CREDIT_COST[d]}c
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Camera movement (video only) */}
        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Camera
              <InfoTip tip="Static = locked-off, không zoom/pan — phù hợp e-commerce product shot. Dynamic = để auto-prompt tự quyết camera move (dolly / micro-shift / …)." />
            </span>
            <div className="aspect-chip-row">
              {CAMERA_MOVEMENTS.map((c) => (
                <button
                  key={c.key}
                  className={`aspect-chip${camera === c.key ? " aspect-chip--active" : ""}`}
                  onClick={() => setCamera(c.key)}
                  type="button"
                  title={c.instruction}
                  disabled={isWorking}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Variants stepper — image + storyboard (storyboard reuses the
            image dispatch path; up to 4 composite variants per request).
            Hidden for video (its own one-clip-per-source-variant flow
            above) and prompt nodes. */}
        {!isVideo && !isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">Variants</span>
            <div className="variants-stepper">
              <button
                type="button"
                disabled={isWorking || variants <= 1}
                aria-label="Decrease variants"
                onClick={() => setVariants((v) => Math.max(1, v - 1))}
              >
                −
              </button>
              <span>{variants}</span>
              <button
                type="button"
                disabled={isWorking || variants >= 4}
                aria-label="Increase variants"
                onClick={() => setVariants((v) => Math.min(4, v + 1))}
              >
                +
              </button>
              <span className="variants-stepper__hint">1–4 images per request</span>
            </div>
          </div>
        )}

        {/* Grid radio — storyboard only. Three options: 2x2 (4 panels),
            2x3 (6), 2x4 (8). For 2x3 / 2x4 the rows × cols flip based on
            the chosen aspect ratio: landscape → wide grid (e.g. 2×3),
            portrait → tall grid (3×2). */}
        {isStoryboard && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Grid
              <InfoTip tip="Storyboard renders as a SINGLE composite image — Flow draws the whole grid as one picture. The topic field above is your story (e.g. Rùa và Thỏ); the locked template wraps it for you. For 2×3 / 2×4 the rows × cols flip with the aspect ratio so panels stay readable on both landscape and portrait composites." />
            </span>
            <div className="aspect-chip-row">
              {STORYBOARD_GRIDS.map((g) => {
                const total = totalPanels(g);
                const isPortrait = aspectRatio.includes("PORTRAIT");
                // For symmetric 2x2 the label is just "2×2". For 2x3 /
                // 2x4 we render the concrete rows×cols pair that Flow
                // will receive, so the user sees orientation reflected.
                let dimsLabel = "2×2";
                if (g !== "2x2") {
                  const big = g === "2x3" ? 3 : 4;
                  dimsLabel = isPortrait ? `${big}×2` : `2×${big}`;
                }
                return (
                  <button
                    key={g}
                    type="button"
                    className={`aspect-chip${storyboardGrid === g ? " aspect-chip--active" : ""}`} disabled={isWorking}
                    onClick={() => setStoryboardGrid(g)}
                    title={`${total} panels (${dimsLabel})`}
                  >
                    {dimsLabel} · {total} panels
                  </button>
                );
              })}
            </div>
          </div>
        )}

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
