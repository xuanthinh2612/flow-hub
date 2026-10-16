import { patchNode } from "../../../canvas/canvasApi.ts";
import { useBoardStore } from "../../../store/board.ts";

export function submitPrompt(rfId: string, prompt: string, closeGenerationDialog: () => void): void {
  useBoardStore.getState().updateNodeGeneration(rfId, { prompt });
  useBoardStore.getState().updateNodeData(rfId, { status: prompt.trim() ? "done" : "idle" });
  const dbId = parseInt(rfId, 10);
  if (!isNaN(dbId)) patchNode(dbId, { status: prompt.trim() ? "done" : "idle" }).catch(() => {});
  closeGenerationDialog();
}
