import type React from "react";
import type { VideoQuality } from "../../store/settings";

export const IMAGE_ASPECT_RATIOS = [
  { key: "IMAGE_ASPECT_RATIO_SQUARE", label: "1:1" },
  { key: "IMAGE_ASPECT_RATIO_PORTRAIT", label: "9:16" },
  { key: "IMAGE_ASPECT_RATIO_LANDSCAPE", label: "16:9" },
] as const;

export const VIDEO_ASPECT_RATIOS = [
  { key: "VIDEO_ASPECT_RATIO_LANDSCAPE", label: "16:9 landscape" },
  { key: "VIDEO_ASPECT_RATIO_PORTRAIT", label: "9:16 portrait" },
] as const;

// Camera movement presets for video.
// - `static` (default): locked-off, no zoom/pan — best for e-commerce
//   product showcase since it keeps the product fully framed.
// - `dynamic`: no camera constraint — the auto-prompt synthesiser is free
//   to suggest dolly / pan / etc. as it sees fit. Empty instruction → no
//   constraint string appended to the final prompt either.
export const CAMERA_MOVEMENTS = [
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

export type CameraKey = (typeof CAMERA_MOVEMENTS)[number]["key"];

// Video model picker shown in the dialog — mirrors the unified list from
// SettingsPanel so the user can override the model per-dispatch without
// opening the gear menu. Selecting a chip mutates the global settings
// store (same pattern as the Omni-duration chips below), so the choice
// is sticky for subsequent dispatches.
// Each chip is either a Veo quality combo or Omni Flash. `ultraOnly`
// chips are locked when the detected paygate tier isn't TIER_TWO —
// the backend would silently fall back to Fast otherwise.
export type VeoChip = {
  kind: "veo";
  quality: VideoQuality;
  label: string;
  ultraOnly: boolean;
};
export type OmniChip = { kind: "omni"; label: string };
export type VideoModelChip = VeoChip | OmniChip;

export const VIDEO_MODEL_CHIPS: readonly VideoModelChip[] = [
  { kind: "veo", quality: "lite", label: "Veo 3.1 Lite", ultraOnly: false },
  { kind: "veo", quality: "fast", label: "Veo 3.1 Fast", ultraOnly: false },
  { kind: "veo", quality: "quality", label: "Veo 3.1 Quality", ultraOnly: false },
  { kind: "veo", quality: "lite_relaxed", label: "Veo 3.1 Lite (Low Priority)", ultraOnly: true },
  { kind: "omni", label: "Omni Flash" },
];

export const CONNECTED_CONTINUATION_MODELS: readonly VideoModelChip[] = VIDEO_MODEL_CHIPS;
export const CONNECTED_R2V_MODELS: readonly VideoModelChip[] = VIDEO_MODEL_CHIPS;

export type ImageAspectKey = (typeof IMAGE_ASPECT_RATIOS)[number]["key"];
export type VideoAspectKey = (typeof VIDEO_ASPECT_RATIOS)[number]["key"];
export type AspectKey = ImageAspectKey | VideoAspectKey;
export const REF_SOURCE_TYPES = new Set(["character", "image", "visual_asset", "Storyboard", "video"]);

// Map an upstream image aspect onto the closest video aspect. Square has
// no direct video equivalent — fall back to portrait per the
// "default-to-9:16 on mismatch" rule.
export const ENABLE_MUSE_BACKEND = false;
export const MINI_SELECT_STYLE: React.CSSProperties = { padding: '2px 8px', borderRadius: '4px', background: '#333', color: '#fff', border: 'none' };
