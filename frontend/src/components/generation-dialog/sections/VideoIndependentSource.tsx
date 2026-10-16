import type { RefObject } from "react";
import type { VideoUpstreamInfo } from "../../../utils/videoFrame";
import { MediaPicker } from "../../MediaPicker";
import { MINI_SELECT_STYLE } from "../constants";
import { VideoReferencePanel } from "./VideoReferencePanel";

interface VideoIndependentSourceProps {
  isVideo: boolean;
  videoInfo: VideoUpstreamInfo | null;
  isOmniVideo: boolean;
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
  independentVideoMediaIds: string[];
  persistIndependentVideoMode: (value: "i2v" | "r2v") => void;
  independentVideoMode: "i2v" | "r2v";
  persistIndependentVideoSelection: (value: string[]) => void;
}

export function VideoIndependentSource({
  isVideo,
  videoInfo,
  isOmniVideo,
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
  independentVideoMediaIds,
  persistIndependentVideoMode,
  independentVideoMode,
  persistIndependentVideoSelection,
}: VideoIndependentSourceProps) {
  return (
    <>
        {isVideo && videoInfo?.mode === "t2v" && (
          <div className="gen-dialog__field">
            {isOmniVideo && omniVideoMode === "video_reference" ? (
              <VideoReferencePanel
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
              />
            ) : (
              <div className="source-info-box source-info-box--t2v">
                <span className="source-info-box__icon">笨ｨ</span>
                <div className="source-info-box__content" style={{ width: '100%' }}>
                  <div className="gen-dialog__label-row">
                    <span className="source-info-box__title">Ch蘯ｿ ﾄ黛ｻ・ Text/Image to Video</span>
                    {isOmniVideo && (
                      <select
                        className="source-select-mini"
                        value={omniVideoMode}
                        onChange={(e) => setOmniVideoMode(e.target.value as "default" | "video_reference")}
                        disabled={isWorking}
                        style={MINI_SELECT_STYLE}
                      >
                        <option value="default">蘯｢nh / Text (T2V/I2V/R2V)</option>
                        <option value="video_reference">Tham chi蘯ｿu video</option>
                      </select>
                    )}
                    {independentVideoMediaIds.length === 1 && !isOmniVideo && (
                      <select
                        className="source-select-mini"
                        value={independentVideoMode}
                        onChange={(e) => persistIndependentVideoMode(e.target.value as "i2v" | "r2v")}
                        disabled={isWorking}
                        style={MINI_SELECT_STYLE}
                      >
                        <option value="i2v">N盻訴 ti蘯ｿp (i2v)</option>
                        <option value="r2v">Ingredients (r2v)</option>
                      </select>
                    )}
                    {independentVideoMediaIds.length > 1 && !isOmniVideo && (
                      <span className="source-select-mini" style={{ ...MINI_SELECT_STYLE, color: '#fb923c', display: 'inline-block' }}>
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
    </>
  );
}
