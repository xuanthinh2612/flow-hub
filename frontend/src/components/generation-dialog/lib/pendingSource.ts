import type { FlowNode } from "../../../store/board";

export function mediaNounFor(node: FlowNode): "ảnh" | "video" {
  return node.data.type === "video" ? "video" : "ảnh";
}

export function pendingSourceMessage(node: FlowNode): string {
  const id = node.data.shortId || node.id;
  const noun = mediaNounFor(node);
  const status = node.data.status;
  if (status === "queued" || status === "running") {
    return `Node #${id} đang được tạo ${noun} — vui lòng chờ hoàn thành trước.`;
  }
  if (status === "done") {
    return `Node #${id} đã xong nhưng chưa có ${noun} file. Hãy tạo lại ${noun} trước khi gen node này.`;
  }
  return `Node #${id} chưa có ${noun} kết quả. Hãy tạo ${noun} trước khi gen node này.`;
}

