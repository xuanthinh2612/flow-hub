import type { VideoUpstreamInfo } from "../../../utils/videoFrame";
import type { VideoUiKey } from "./resolveVideoMode";

export interface VideoModeUiContext {
  independentVideoEffectiveMode: "t2v" | "i2v" | "r2v" | "video_reference";
  independentVideoModeLabel: string;
  isOmniVideo: boolean;
  isExtend: boolean;
  isEffectiveR2v: boolean;
  videoInfo: VideoUpstreamInfo | null;
}

interface VideoModeUiEntry {
  title: string;
  placeholder: string;
  badgeLabel: (context: VideoModeUiContext) => string;
  badgeClass: (context: VideoModeUiContext) => string;
}

export const VIDEO_MODE_UI: Record<VideoUiKey, VideoModeUiEntry> = {
  video_reference: {
    title: "Tham chiếu video (Omni Flash - jIps6)",
    placeholder:
      "Mô tả chỉnh sửa video theo video tham chiếu (vd: đổi nhân vật trong video, đổi trang phục, bối cảnh)…",
    badgeLabel: () => "Tham chiếu video (Omni Flash)",
    badgeClass: () => "video_reference",
  },
  independent_t2v: {
    title: "Tạo video từ Text (t2v)",
    placeholder: "Nhập mô tả video cần tạo (Text to Video)…",
    badgeLabel: (context) => context.independentVideoModeLabel,
    badgeClass: () => "t2v",
  },
  independent_i2v: {
    title: "Tạo video từ Ảnh (i2v)",
    placeholder:
      "Bỏ trống để tự sinh motion prompt từ source image ✨ hoặc nhập prompt…",
    badgeLabel: (context) => context.independentVideoModeLabel,
    badgeClass: () => "i2v",
  },
  independent_r2v: {
    title: "Tạo video từ Ingredients (r2v)",
    placeholder:
      "Bỏ trống để tự sinh motion prompt từ các source images ✨ hoặc nhập prompt…",
    badgeLabel: (context) => context.independentVideoModeLabel,
    badgeClass: () => "r2v",
  },
  continuation_extend: {
    title: "Kéo dài video (Extend Video)",
    placeholder:
      "Nhập mô tả diễn biến tiếp theo để kéo dài video (Veo Extension)…",
    badgeLabel: () => "Extend video (Veo)",
    badgeClass: () => "extend",
  },
  continuation_omni: {
    title: "Nối tiếp video (Omni Flash)",
    placeholder:
      "Nhập mô tả diễn biến tiếp theo dựa trên video nguồn…",
    badgeLabel: () => "Nối tiếp video (Omni Flash)",
    badgeClass: () => "video_continuation",
  },
  continuation_lastframe: {
    title: "Nối tiếp video (Frame cuối)",
    placeholder:
      "Nhập mô tả diễn biến tiếp theo sau frame cuối của video trước…",
    badgeLabel: (context) => context.videoInfo?.label ?? "Nối tiếp video (i2v)",
    badgeClass: () => "video_continuation",
  },
  connected: {
    title: "T\u1ea1o video t\u1eeb ngu\u1ed3n \u0111\u00e3 n\u1ed1i",
    placeholder: "M\u00f4 t\u1ea3 c\u00e1ch ngu\u1ed3n \u0111\u00e3 n\u1ed1i \u0111\u1ecbnh h\u00ecnh video m\u1edbi.",
    badgeLabel: context => context.isEffectiveR2v ? "Ingredients (R2V)" : context.videoInfo?.label ?? "Connected source",
    badgeClass: context => context.isEffectiveR2v ? "r2v" : context.videoInfo?.mode ?? "i2v",
  },
};
