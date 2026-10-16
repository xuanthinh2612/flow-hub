import type { RefObject } from "react";
import { totalPanels } from "../../../lib/storyboardPrompt";
import type { StoryboardGrid } from "../../../store/board";

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
  videoPlaceholder: string;
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
  videoPlaceholder,
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
                  ? videoPlaceholder
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
