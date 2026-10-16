import { VIDEO_MODEL_CHIPS } from "../constants";
import type { VideoModelFamily, VideoQuality } from "../../../store/settings";
import { InfoTip } from "../InfoTip";

interface VideoModelFieldProps {
  isVideo: boolean;
  isExtend: boolean;
  videoModelFamily: VideoModelFamily;
  videoQuality: VideoQuality;
  setVideoModel: (value: VideoModelFamily) => void;
  setVideoQuality: (value: VideoQuality) => void;
  isWorking: boolean;
  paygateTier: string | null;
}

export function VideoModelField({
  isVideo,
  isExtend,
  videoModelFamily,
  videoQuality,
  setVideoModel,
  setVideoQuality,
  isWorking,
  paygateTier,
}: VideoModelFieldProps) {
  return (
    <>
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
    </>
  );
}
