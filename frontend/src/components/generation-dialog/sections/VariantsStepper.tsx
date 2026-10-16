import type { Dispatch, SetStateAction } from "react";

interface VariantsStepperProps {
  isVideo: boolean;
  isPrompt: boolean;
  variants: number;
  setVariants: Dispatch<SetStateAction<number>>;
  isWorking: boolean;
}

export function VariantsStepper({
  isVideo,
  isPrompt,
  variants,
  setVariants,
  isWorking,
}: VariantsStepperProps) {
  return (
    <>
      {/* Variants stepper ? image + storyboard (storyboard reuses the
          image dispatch path; up to 4 composite variants per request).
          Hidden for video (its own one-clip-per-source-variant flow
          above) and prompt nodes. */}
        {!isVideo && !isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">Variants</span>
            <div className="variants-stepper">
              <button
                type="button"
                disabled={isWorking || variants <= 1}
                aria-label="Decrease variants"
                onClick={() => setVariants((v) => Math.max(1, v - 1))}
              >
                −
              </button>
              <span>{variants}</span>
              <button
                type="button"
                disabled={isWorking || variants >= 4}
                aria-label="Increase variants"
                onClick={() => setVariants((v) => Math.min(4, v + 1))}
              >
                +
              </button>
              <span className="variants-stepper__hint">1–4 images per request</span>
            </div>
          </div>
        )}
    </>
  );
}
