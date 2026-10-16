import { STORYBOARD_GRIDS, totalPanels } from "../../../lib/storyboardPrompt";
import type { StoryboardGrid } from "../../../store/board";
import { InfoTip } from "../InfoTip";

interface StoryboardGridFieldProps {
  isStoryboard: boolean;
  storyboardGrid: StoryboardGrid;
  setStoryboardGrid: (value: StoryboardGrid) => void;
  aspectRatio: string;
  isWorking: boolean;
}

export function StoryboardGridField({
  isStoryboard,
  storyboardGrid,
  setStoryboardGrid,
  aspectRatio,
  isWorking,
}: StoryboardGridFieldProps) {
  return (
    <>
      {/* Grid radio ? storyboard only. Three options: 2x2 (4 panels),
          2x3 (6), 2x4 (8). For 2x3 / 2x4 the rows ? cols flip based on
          the chosen aspect ratio: landscape ? wide grid (e.g. 2?N),
          portrait ? tall grid (N?2). */}
        {isStoryboard && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Grid
              <InfoTip tip="Storyboard renders as a SINGLE composite image — Flow draws the whole grid as one picture. The topic field above is your story (e.g. Rùa và Thỏ); the locked template wraps it for you. For 2×3 / 2×4 the rows × cols flip with the aspect ratio so panels stay readable on both landscape and portrait composites." />
            </span>
            <div className="aspect-chip-row">
              {STORYBOARD_GRIDS.map((g) => {
                const total = totalPanels(g);
                const isPortrait = aspectRatio.includes("PORTRAIT");
                // For symmetric 2x2 the label is just "2×2". For 2x3 /
                // 2x4 we render the concrete rows×cols pair that Flow
                // will receive, so the user sees orientation reflected.
                let dimsLabel = "2×2";
                if (g !== "2x2") {
                  const big = g === "2x3" ? 3 : 4;
                  dimsLabel = isPortrait ? `${big}×2` : `2×${big}`;
                }
                return (
                  <button
                    key={g}
                    type="button"
                    className={`aspect-chip${storyboardGrid === g ? " aspect-chip--active" : ""}`} disabled={isWorking}
                    onClick={() => setStoryboardGrid(g)}
                    title={`${total} panels (${dimsLabel})`}
                  >
                    {dimsLabel} · {total} panels
                  </button>
                );
              })}
            </div>
          </div>
        )}
    </>
  );
}
