import { IMAGE_ASPECT_RATIOS, VIDEO_ASPECT_RATIOS } from "../constants";

interface AspectRatioFieldProps {
  isPrompt: boolean;
  isVideo: boolean;
  aspectRatio: string;
  setAspectRatio: (value: string) => void;
  isWorking: boolean;
}

export function AspectRatioField({
  isPrompt,
  isVideo,
  aspectRatio,
  setAspectRatio,
  isWorking,
}: AspectRatioFieldProps) {
  return (
    <>
      {/* Aspect ratio ? irrelevant for prompt nodes (text-only). */}
        {!isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">Aspect ratio</span>
            <div className="aspect-chip-row">
              {(isVideo ? VIDEO_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS).map((ar) => (
                <button
                  key={ar.key}
                  className={`aspect-chip${aspectRatio === ar.key ? " aspect-chip--active" : ""}`}
                  onClick={() => setAspectRatio(ar.key)}
                  type="button"
                  disabled={isWorking}
                >
                  {ar.label}
                </button>
              ))}
            </div>
          </div>
        )}
    </>
  );
}
