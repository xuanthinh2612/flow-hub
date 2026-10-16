import {
  OMNI_FLASH_CREDIT_COST,
  OMNI_FLASH_DURATIONS,
  OMNI_FLASH_RESOLUTIONS,
  type OmniFlashDuration,
  type OmniFlashResolution,
} from "../../../store/settings";
import { InfoTip } from "./InfoTip";

interface OmniOptionsProps {
  isOmniVideo: boolean;
  omniFlashResolution: OmniFlashResolution;
  setOmniFlashResolution: (value: OmniFlashResolution) => void;
  omniFlashDuration: OmniFlashDuration;
  setOmniFlashDuration: (value: OmniFlashDuration) => void;
  isWorking: boolean;
}

export function OmniOptions({
  isOmniVideo,
  omniFlashResolution,
  setOmniFlashResolution,
  omniFlashDuration,
  setOmniFlashDuration,
  isWorking,
}: OmniOptionsProps) {
  return (
    <>
      {/* Omni Flash options are visible only while Omni is selected. */}
        {isOmniVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Resolution (Omni Flash)
              <InfoTip tip="Chọn độ phân giải cho Omni Flash. 720p cho chất lượng cao hơn; 360p có chi phí thấp hơn." />
            </span>
            <div className="aspect-chip-row">
              {OMNI_FLASH_RESOLUTIONS.map((resolution) => (
                <button
                  key={resolution}
                  type="button"
                  className={`aspect-chip${omniFlashResolution === resolution ? " aspect-chip--active" : ""}`}
                  disabled={isWorking}
                  onClick={() => setOmniFlashResolution(resolution as OmniFlashResolution)}
                >
                  {resolution}
                </button>
              ))}
            </div>
          </div>
        )}

        {isOmniVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Duration (Omni Flash)
              <InfoTip tip="Omni Flash dispatches via video:batchAsyncGenerateVideoReferenceImages with the upstream image(s) as IMAGE_USAGE_TYPE_ASSET refs. Duration scales credit cost: 4s=15, 6s=20, 8s=25, 10s=30." />
            </span>
            <div className="aspect-chip-row">
              {OMNI_FLASH_DURATIONS.map((d) => {
                const active = omniFlashDuration === d;
                return (
                  <button
                    key={d}
                    type="button"
                    className={`aspect-chip${active ? " aspect-chip--active" : ""}`} disabled={isWorking}
                    onClick={() =>
                      setOmniFlashDuration(d as OmniFlashDuration)
                    }
                    title={`${d}s — ${OMNI_FLASH_CREDIT_COST[d]} credits`}
                  >
                    {d}s · {OMNI_FLASH_CREDIT_COST[d]}c
                  </button>
                );
              })}
            </div>
          </div>
        )}
    </>
  );
}
