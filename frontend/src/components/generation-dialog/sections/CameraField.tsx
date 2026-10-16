import { CAMERA_MOVEMENTS, type CameraKey } from "../constants";
import { InfoTip } from "./InfoTip";

interface CameraFieldProps {
  isVideo: boolean;
  camera: CameraKey;
  setCamera: (value: CameraKey) => void;
  isWorking: boolean;
}

export function CameraField({ isVideo, camera, setCamera, isWorking }: CameraFieldProps) {
  return (
    <>
      {/* Camera movement (video only) */}
        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Camera
              <InfoTip tip="Static = locked-off, không zoom/pan — phù hợp e-commerce product shot. Dynamic = để auto-prompt tự quyết camera move (dolly / micro-shift / …)." />
            </span>
            <div className="aspect-chip-row">
              {CAMERA_MOVEMENTS.map((c) => (
                <button
                  key={c.key}
                  className={`aspect-chip${camera === c.key ? " aspect-chip--active" : ""}`}
                  onClick={() => setCamera(c.key)}
                  type="button"
                  title={c.instruction}
                  disabled={isWorking}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}
    </>
  );
}
