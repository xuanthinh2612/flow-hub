import type { RefObject } from "react";
import { totalPanels } from "../../../lib/storyboardPrompt";
import type { StoryboardGrid } from "../../../store/board";
import type { VideoUpstreamInfo } from "../../../utils/videoFrame";

interface PromptFieldProps {
  isVideo: boolean;
  isPrompt: boolean;
  isWorking: boolean;
  extractingFrame: boolean;
  extractError: string | undefined;
  hasStoryboardUpstream: boolean;
  storyboardUpstreamGrid: StoryboardGrid;
  prompt: string;
  setPrompt: (value: string) => void;
  autoPromptUsed: boolean;
  setAutoPromptUsed: (value: boolean) => void;
  firstFocusRef: RefObject<HTMLTextAreaElement | null>;
  isOmniVideo: boolean;
  omniVideoMode: "default" | "video_reference";
  videoInfo: VideoUpstreamInfo | null;
  independentVideoEffectiveMode: string | undefined;
  isExtend: boolean;
  aiBriefStatus: string | undefined;
}

export function PromptField({
  isVideo,
  isPrompt,
  isWorking,
  extractingFrame,
  extractError,
  hasStoryboardUpstream,
  storyboardUpstreamGrid,
  prompt,
  setPrompt,
  autoPromptUsed,
  setAutoPromptUsed,
  firstFocusRef,
  isOmniVideo,
  omniVideoMode,
  videoInfo,
  independentVideoEffectiveMode,
  isExtend,
  aiBriefStatus,
}: PromptFieldProps) {
  return (
    <>
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
                {aiBriefStatus === "pending"
                  ? "✨ Đang phân tích image…"
                  : "✨ Đang dựng prompt từ upstream context…"}
              </p>
            )}
        </div>
    </>
  );
}
