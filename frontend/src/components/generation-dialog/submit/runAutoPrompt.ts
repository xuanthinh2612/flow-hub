import { autoPrompt, autoPromptBatch } from "../../../canvas/canvasApi.ts";
import { useBoardStore } from "../../../store/board.ts";

export interface RunAutoPromptInput {
  rfId: string;
  isVideo: boolean;
  variants: number;
  camera: string;
}

export async function runAutoPrompt({
  rfId,
  isVideo,
  variants,
  camera,
}: RunAutoPromptInput): Promise<{
  finalPrompt: string;
  perVariantPrompts?: string[];
  displayPrompt?: string;
}> {
  const dbId = parseInt(rfId, 10);
  if (isNaN(dbId)) throw new Error("Auto-prompt failed: invalid node id");

  useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "pending" });
  try {
    if (!isVideo && variants > 1) {
      const res = await autoPromptBatch(dbId, variants);
      useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
      return { finalPrompt: res.prompts[0] ?? "", perVariantPrompts: res.prompts };
    }

    const res = await autoPrompt(dbId, isVideo ? { camera } : undefined);
    useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
    return { finalPrompt: res.prompt, displayPrompt: res.prompt };
  } catch (err) {
    useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "failed" });
    throw err;
  }
}
