import { VIDEO_MODEL_CHIPS } from "../constants";
import type { VideoModelFamily, VideoQuality } from "../../../store/settings";
import type { ConnectedVideoAction } from "../types";
import { InfoTip } from "./InfoTip";

interface VideoModelFieldProps {
  isVideo: boolean;
  connectedVideoAction: ConnectedVideoAction | null;
  videoModelFamily: VideoModelFamily;
  videoQuality: VideoQuality;
  setVideoModel: (value: VideoModelFamily) => void;
  setVideoQuality: (value: VideoQuality) => void;
  isWorking: boolean;
  paygateTier: string | null;
}

export function VideoModelField({
  isVideo,
  connectedVideoAction,
  videoModelFamily,
  videoQuality,
  setVideoModel,
  setVideoQuality,
  isWorking,
  paygateTier,
}: VideoModelFieldProps) {
  const fixedModelLabel = connectedVideoAction === "extend"
    ? "Veo 3.1 Extension Lite (fZytfe)"
    : connectedVideoAction === "video_reference"
      ? "Omni Flash"
      : null;
  const modelOptions = VIDEO_MODEL_CHIPS;

  return (
    <>
      {/* Model picker comes first so selecting Omni reveals its options
          directly below. */}
        {isVideo && fixedModelLabel ? (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Model
              <InfoTip tip={
                connectedVideoAction === "extend"
                  ? "Veo 3.1 Extension Lite (fZytfe): Model chuyên dụng của Flow để kéo dài video clip đã có."
                  : "Omni Flash: Model chuyên dụng của Flow để chỉnh sửa/tạo video từ video tham chiếu (jIps6)."
              } />
            </span>
            <div style={{ padding: '8px 12px', background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '6px', fontSize: '13px', color: '#fff' }}>
              {fixedModelLabel}
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
              {modelOptions.map((m) => {
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
    </>
  );
}
