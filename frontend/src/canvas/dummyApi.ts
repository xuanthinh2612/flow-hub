import { api, mediaFile, withKey } from "../api/client";
import type { JobItem } from "../api/types";

export const mediaUrl = (id: string) => {
  if (!id) return '';
  if (id.startsWith('http') || id.startsWith('/api/')) return withKey(id);
  return mediaFile(id);
};

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

export async function uploadImageFromUrl(url: string, projectId?: string, dbId?: number) {
  return { media_id: "mock", aspect_ratio: "16:9" };
}

export function requestAutoBrief(rfId: string, mediaId: string) {
  // no-op
}

export async function autoPrompt(...args: any[]): Promise<any> { return { prompt: "auto" }; }
export async function autoPromptBatch(...args: any[]): Promise<any> { return { prompts: ["auto", "auto", "auto", "auto"] }; }

export interface MediaStatus {
  available: boolean;
  has_url: boolean;
  mime?: string;
  reason?: string;
}

export async function getMediaStatus(_mediaId: string): Promise<MediaStatus> {
  return { available: true, has_url: true };
}