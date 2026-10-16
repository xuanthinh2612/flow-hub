import type { VideoUpstreamInfo } from "../../../utils/videoFrame";
import { SourcePendingNotice } from "./SourcePendingNotice";
import { MINI_SELECT_STYLE } from "../constants";
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
  isWorking,
}: VideoContinuationPanelProps) {
  return (
    <>
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
                      {isUpstreamVeoVideo && !isOmniVideo && (
                        <select
                          className="source-select-mini"
                          value={videoExtendMode}
                          onChange={(e) => setVideoExtendMode(e.target.value as "continuation" | "extend")}
                          disabled={isWorking}
                          style={MINI_SELECT_STYLE}
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
                          style={MINI_SELECT_STYLE}
                        >
                          <option value="default">Nối tiếp video (Omni Flash)</option>
                          <option value="video_reference">Tham chiếu video này</option>
                        </select>
                      )}
                    </div>
                    <p className="source-info-box__desc">
                      {isExtend
                        ? "Kéo dài video trực tiếp bằng Veo Extension Lite (fZytfe). Giữ liền mạch bối cảnh và chuyển động của video gốc."
                        : (isOmniVideo
                            ? (omniVideoMode === "video_reference"
                                ? "Sử dụng video của node trước làm video tham chiếu trực tiếp cho Omni Flash (jIps6)."
                                : "Dùng video của node trước làm nguồn nối tiếp cho Omni Flash.")
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
                            : (isOmniVideo
                                ? "✓ Sẵn sàng nối tiếp bằng video này với Omni Flash"
                                : "✓ Sẵn sàng trích xuất frame cuối khi bấm Generate"))}
                    </span>
                  </div>
                )}
              </div>
            )}
    </>
  );
}
