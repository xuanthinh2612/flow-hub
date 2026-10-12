import { api, mediaFile, withKey } from "../api/client";
import type { JobItem, MediaItem } from "../api/types";

export const mediaUrl = (id: string) => {
  if (!id) return '';
  if (id.startsWith('http') || id.startsWith('/api/')) return withKey(id);
  return mediaFile(id);
};

export async function patchEdge(id: number, data: any) {
  return api(`/api/edges/${id}`, { method: "PATCH", body: data });
}

import { patchNode as storePatchNode } from "../store/boardApi";

export async function patchNode(id: number, data: any) {
  return storePatchNode(id, data);
}

export async function uploadImage(file: File, projectId?: string, dbId?: number, workspaceId?: string) {
  const form = new FormData();
  form.append("file", file);
  if (projectId && projectId !== "default") form.append("project_id", projectId);
  if (workspaceId) form.append("workspace_id", workspaceId);
  const resp = await api<{ id: string; media_id?: string; aspect_ratio?: string }>("/api/uploads", {
    method: "POST",
    form,
  });

  if (resp.media_id) {
    return { media_id: resp.media_id, aspect_ratio: resp.aspect_ratio || "16:9" };
  }

  // In flow-hub, POST /api/uploads returns an upload job { id: "<job_id>" }.
  // Poll until the job completes to get the uploaded media_id.
  const jobId = resp.id;
  const startTime = Date.now();
  while (Date.now() - startTime < 60000) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      const job = await api<JobItem>(`/api/jobs/${jobId}`);
      if (job.status === "done" && job.results && job.results.length > 0) {
        return { media_id: job.results[0].media_id, aspect_ratio: "16:9" };
      }
      if (job.status === "failed" || job.status === "canceled") {
        throw new Error(job.error || "Upload ảnh thất bại");
      }
    } catch (e: any) {
      if (e.message && (e.message.includes("Upload ảnh thất bại") || e.message.includes("404"))) {
        throw e;
      }
    }
  }

  return { media_id: resp.id, aspect_ratio: "16:9" };
}

export async function uploadImageFromUrl(_url: string, _projectId?: string, _dbId?: number): Promise<{ media_id: string; aspect_ratio?: string }> {
  throw new Error("Upload from URL is not supported. Download the image and upload the file instead.");
}

export async function autoPrompt(_rfId: number, _options?: { camera?: string }): Promise<{ prompt: string }> {
  throw new Error("Automatic prompt generation is not available in this backend.");
}

export async function autoPromptBatch(_rfId: number, _count: number): Promise<{ prompts: string[] }> {
  throw new Error("Automatic prompt generation is not available in this backend.");
}

export interface MediaStatus {
  available: boolean;
  has_url: boolean;
  mime?: string;
  reason?: string;
}

export async function getMediaStatus(mediaId: string): Promise<MediaStatus> {
  const item = await api<MediaItem>(`/api/media/${encodeURIComponent(mediaId)}`);
  return {
    available: Boolean(item.local_path || item.url),
    has_url: Boolean(item.url),
  };
}
