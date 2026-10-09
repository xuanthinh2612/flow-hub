import { api, mediaFile } from "../api/client";

export const mediaUrl = mediaFile;

export async function patchEdge(id: number, data: any) {
  return data;
}

export async function patchNode(id: number, data: any) {
  return data;
}

export async function uploadImage(file: File, projectId?: string, dbId?: number) {
  const form = new FormData();
  form.append("file", file);
  if (projectId) form.append("project_id", projectId);
  const resp = await api<{ id: string; media_id: string; aspect_ratio: string }>("/api/uploads", {
    method: "POST",
    form,
  });
  return { media_id: resp.media_id || resp.id, aspect_ratio: "16:9" };
}

export async function uploadImageFromUrl(url: string) {
  return { media_id: "mock", aspect_ratio: "16:9" };
}

export function requestAutoBrief(rfId: string, mediaId: string) {
  // no-op
}
