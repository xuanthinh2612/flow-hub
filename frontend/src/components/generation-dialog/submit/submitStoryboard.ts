import { buildStoryboardPrompt } from "../../../lib/storyboardPrompt.ts";
import { patchNode } from "../../../canvas/canvasApi.ts";
import { useBoardStore } from "../../../store/board.ts";
import type { DispatchOpts } from "./submitVideo.ts";

export function submitStoryboard(ctx: {
  rfId: string;
  prompt: string;
  storyboardGrid: Parameters<typeof buildStoryboardPrompt>[1];
  aspectRatio: string;
  variants: number;
  dispatchGeneration: (rfId: string, opts: DispatchOpts) => Promise<void>;
  closeGenerationDialog: () => void;
}): void {
  const { rfId, prompt, storyboardGrid, aspectRatio, variants, dispatchGeneration, closeGenerationDialog } = ctx;
  const wrapped = buildStoryboardPrompt(prompt, storyboardGrid, aspectRatio);
  useBoardStore.getState().updateNodeGeneration(rfId, { prompt, storyboardGrid });
  useBoardStore.getState().updateNodeData(rfId, { aiBrief: prompt });
  const dbId = parseInt(rfId, 10);
  if (!isNaN(dbId)) patchNode(dbId, { data: { aiBrief: prompt } }).catch(() => {});
  dispatchGeneration(rfId, { prompt: wrapped, aspectRatio, kind: "image", variantCount: variants });
  closeGenerationDialog();
}
