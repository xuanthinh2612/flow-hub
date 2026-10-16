import type { VideoUpstreamInfo } from "../../../utils/videoFrame";
import { SourcePendingNotice } from "./SourcePendingNotice";
import { mediaUrl } from "../../../canvas/canvasApi";

interface VideoContinuationPanelProps {
  videoInfo: VideoUpstreamInfo | null;
  isExtend: boolean;
  isOmniVideo: boolean;
  omniVideoMode: "default" | "video_reference";
  setOmniVideoMode: (value: "default" | "video_reference") => void;
  isUpstreamVeoVideo: boolean;
  videoExtendMode: "continuation" | "extend";
  setVideoExtendMode: (value: "continuation" | "extend") => void;
  connectedVideoMode: "i2v" | "r2v";
  setConnectedVideoMode: (value: "i2v" | "r2v") => void;
  isWorking: boolean;
}

export function VideoContinuationPanel({
  videoInfo,
  isExtend,
  isOmniVideo,
  omniVideoMode,
  setOmniVideoMode,
  isUpstreamVeoVideo,
  videoExtendMode,
  setVideoExtendMode,
  connectedVideoMode,
  setConnectedVideoMode,
  isWorking,
}: VideoContinuationPanelProps) {
  const selectedMode = isOmniVideo && omniVideoMode === "video_reference"
    ? "video_reference"
    : connectedVideoMode === "r2v"
      ? "r2v"
      : isExtend
        ? "extend"
        : "continuation";

  const handleModeChange = (value: string) => {
    setConnectedVideoMode(value === "r2v" ? "r2v" : "i2v");
    setVideoExtendMode(value === "extend" ? "extend" : "continuation");
    setOmniVideoMode(value === "video_reference" ? "video_reference" : "default");
  };

  return (
    <>
            {videoInfo?.mode === "video_continuation" && (
              <div className="source-info-box source-info-box--continuation">
                <div className="source-info-box__header">
                  <span className="source-info-box__icon">🎬</span>
                  <div className="source-info-box__content" style={{ width: '100%' }}>
                    <div className="gen-dialog__label-row" style={{ alignItems: 'center' }}>
                      <span className="source-info-box__title">
                        {connectedVideoMode === "r2v"
                          ? `R2V source video #${videoInfo.sourceNode?.data.shortId}`
                          : isExtend
                            ? `Extend video #${videoInfo.sourceNode?.data.shortId}`
                            : isOmniVideo && omniVideoMode === "video_reference"
                              ? `Video reference #${videoInfo.sourceNode?.data.shortId}`
                              : `Continue video #${videoInfo.sourceNode?.data.shortId}`}
                      </span>
                      <select
                        className="source-mode-select"
                        value={selectedMode}
                        onChange={(e) => handleModeChange(e.target.value)}
                        disabled={isWorking}
                      >
                        <option value="continuation">Nối tiếp video</option>
                        <option value="r2v">Ingredients (r2v)</option>
                        {isUpstreamVeoVideo && !isOmniVideo && (
                          <option value="extend">Kéo dài (Extend video)</option>
                        )}
                        {isOmniVideo && (
                          <option value="video_reference">Tham chiếu video</option>
                        )}
                      </select>
                    </div>
                    <p className="source-info-box__desc">
                      {connectedVideoMode === "r2v"
                        ? "Dùng video nguồn này làm ingredient (R2V) cho video mới."
                        : isExtend
                          ? "Kéo dài video trực tiếp bằng Veo Extension Lite (fZytfe)."
                          : isOmniVideo
                            ? omniVideoMode === "video_reference"
                              ? "Dùng video nguồn làm video tham chiếu cho Omni Flash."
                              : "Dùng video nguồn làm nguồn nối tiếp cho Omni Flash."
                            : "Dùng frame cuối của video nguồn làm frame bắt đầu cho video mới."}
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
                      {connectedVideoMode === "r2v"
                        ? "Video nguồn được chọn làm ingredient (R2V)."
                        : isExtend
                          ? "Sẵn sàng kéo dài video bằng Veo Extension Lite."
                          : isOmniVideo && omniVideoMode === "video_reference"
                            ? "Sẵn sàng dùng video làm tham chiếu cho Omni Flash."
                            : isOmniVideo
                              ? "Sẵn sàng nối tiếp từ video này bằng Omni Flash."
                              : "Sẵn sàng trích frame cuối khi tạo video."}
                    </span>
                  </div>
                )}
              </div>
            )}
    </>
  );
}
