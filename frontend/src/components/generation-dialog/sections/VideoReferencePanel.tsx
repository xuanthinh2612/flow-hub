import type { RefObject } from "react";
import { MediaPicker } from "../../MediaPicker";
import { mediaUrl } from "../../../canvas/canvasApi";

interface VideoReferencePanelProps {
  omniVideoMode: "default" | "video_reference";
  setOmniVideoMode: (value: "default" | "video_reference") => void;
  uploadVideoError: string | null;
  videoReferenceMediaId: string | null;
  setVideoReferenceMediaId: (value: string | null) => void;
  boardPublicId: string | null;
  isWorking: boolean;
  uploadingVideo: boolean;
  videoFileInputRef: RefObject<HTMLInputElement | null>;
  handleUploadVideoFile: (file: File) => Promise<void>;
  r2vAdditionalMediaIds: string[];
  setR2vAdditionalMediaIds: (value: string[]) => void;
}

export function VideoReferencePanel({
  omniVideoMode,
  setOmniVideoMode,
  uploadVideoError,
  videoReferenceMediaId,
  setVideoReferenceMediaId,
  boardPublicId,
  isWorking,
  uploadingVideo,
  videoFileInputRef,
  handleUploadVideoFile,
  r2vAdditionalMediaIds,
  setR2vAdditionalMediaIds,
}: VideoReferencePanelProps) {
  return (

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
                        style={MINI_SELECT_STYLE}
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
  );
}
