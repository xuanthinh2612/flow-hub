/**
 * Canvas persistence API. Project, node, edge and generation drafts live in SQLite.
 */
import { api } from "../api/client";

export type NodeType = "image" | "video" | "prompt" | "character" | "visual_asset" | "Storyboard" | "note" | "merge";

export interface Board {
  id: number;
  public_id: string;
  name: string;
  project_id: string;
  created_at: number;
  worker_id?: string | null;
  flow_project_id?: string | null;
  viewport?: { x: number; y: number; zoom: number } | null;
}

export type NodeStatus = "idle" | "queued" | "running" | "done" | "error";

export interface StoredNode {
  id: number;
  board_id: number;
  type: NodeType;
  short_id: string;
  status: NodeStatus;
  x: number;
  y: number;
  data: Record<string, unknown>;
}

export interface StoredEdge {
  id: number;
  board_id: number;
  source_id: number;
  target_id: number;
  source_variant_idx?: number | null;
}

// ── Board CRUD ─────────────────────────────────────────────────────────

export async function listBoards(): Promise<Board[]> {
  return api<Board[]>("/api/boards");
}

export async function createBoard(name: string, workerId?: string | null, flowProjectId?: string | null): Promise<Board> {
  return api<Board>("/api/boards", { method: "POST", body: {
    name, project_id: "default", worker_id: workerId || null, flow_project_id: flowProjectId || null,
  } });
}

export async function getBoardByPublicId(publicId: string): Promise<Board | null> {
  const boards = await listBoards();
  return boards.find((board) => board.public_id === publicId) ?? null;
}

export async function getBoard(id: number): Promise<{
  board: Board;
  nodes: StoredNode[];
  edges: StoredEdge[];
}> {
  return api<{ board: Board; nodes: StoredNode[]; edges: StoredEdge[] }>(`/api/boards/${id}`);
}

export async function patchBoard(id: number, patch: { name?: string; viewport?: { x: number; y: number; zoom: number }; worker_id?: string | null; flow_project_id?: string | null }): Promise<Board> {
  return api<Board>(`/api/boards/${id}`, { method: "PATCH", body: patch });
}

export async function deleteBoard(id: number): Promise<void> {
  await api(`/api/boards/${id}`, { method: "DELETE" });
}

// ── Node CRUD ──────────────────────────────────────────────────────────

export async function createNode(input: {
  board_id: number;
  type: string;
  x: number;
  y: number;
  data: Record<string, unknown>;
}): Promise<StoredNode> {
  return api<StoredNode>("/api/nodes", { method: "POST", body: input });
}

export async function patchNode(
  id: number,
  patch: Record<string, any>,
  options: { keepalive?: boolean } = {},
): Promise<StoredNode | null> {
  return api<StoredNode>(`/api/nodes/${id}`, { method: "PATCH", body: patch, ...options });
}

export async function deleteNode(id: number): Promise<void> {
  await api(`/api/nodes/${id}`, { method: "DELETE" });
}

// ── Edge CRUD ──────────────────────────────────────────────────────────

export async function createEdge(input: {
  board_id: number;
  source_id: number;
  target_id: number;
}): Promise<StoredEdge> {
  return api<StoredEdge>("/api/edges", { method: "POST", body: input });
}

export async function patchEdge(id: number, patch: { source_variant_idx?: number | null }): Promise<StoredEdge> {
  return api<StoredEdge>(`/api/edges/${id}`, { method: "PATCH", body: patch });
}

export async function deleteEdge(id: number): Promise<void> {
  await api(`/api/edges/${id}`, { method: "DELETE" });
}

// ── Project / request integration ──────────────────────────────────────

export async function ensureBoardProject(boardId?: number): Promise<{ flow_project_id: string }> {
  if (boardId === undefined) return { flow_project_id: "default" };
  const board = await getBoardById(boardId);
  return { flow_project_id: board.flow_project_id || "default" };
}

async function getBoardById(id: number): Promise<Board> {
  const detail = await api<{ board: Board }>(`/api/boards/${id}`);
  return detail.board;
}

export async function createRequest(input: {
  type: string;
  node_id?: number | string;
  params: Record<string, any>;
}): Promise<any> {
  const { type, node_id, params } = input;
  let spec: Record<string, any>;

  if (type === "gen_video_text") {
    const isPortrait = params.aspect_ratio === "VIDEO_ASPECT_RATIO_PORTRAIT";
    spec = {
      type: "t2v",
      family: "veo",
      prompt: params.prompt,
      aspect: isPortrait ? "9:16" : "16:9",
      count: Number(params.variant_count) || 1,
    };
    if (params.video_quality) {
      if (params.video_quality === "fast") {
        spec.model = isPortrait ? "veo_3_1_t2v_fast_portrait" : "veo_3_1_t2v_fast";
      } else {
        spec.model = `veo_3_1_t2v_${params.video_quality}`;
      }
    }
  } else if (type === "gen_video") {
    const extractVideoIds = Array.isArray(params.extract_video_ids) ? params.extract_video_ids : [];
    if (params.video_mode === "r2v" || (params.ref_media_ids && params.ref_media_ids.length > 0) || extractVideoIds.length > 0) {
      const isPortrait = params.aspect_ratio === "VIDEO_ASPECT_RATIO_PORTRAIT";
      spec = {
        type: "r2v",
        family: "veo",
        prompt: params.prompt,
        aspect: isPortrait ? "9:16" : "16:9",
        ref_media_ids: params.ref_media_ids || [],
        extract_video_ids: extractVideoIds,
        count: Number(params.variant_count) || 1,
      };
      if (params.video_quality) {
        const landscapeFastSuffix = params.video_quality === "fast" && !isPortrait ? "_landscape" : "";
        spec.model = `veo_3_1_r2v_${params.video_quality}${landscapeFastSuffix}`;
      }
    } else {
      const startIds = (Array.isArray(params.start_media_ids) && params.start_media_ids.length > 0)
        ? params.start_media_ids
        : params.start_media_id ? [params.start_media_id] : [];
      const isPortrait = params.aspect_ratio === "VIDEO_ASPECT_RATIO_PORTRAIT";
      spec = {
        type: "i2v",
        family: "veo",
        prompt: params.prompt,
        aspect: isPortrait ? "9:16" : "16:9",
        count: startIds.length || 1,
        start_media_ids: startIds,
      };
      if (params.extract_start_video_id) spec.extract_start_video_id = params.extract_start_video_id;
      if (params.video_quality) {
        if (params.video_quality === "fast") {
          spec.model = isPortrait ? "veo_3_1_i2v_s_fast_portrait" : "veo_3_1_i2v_s_fast";
        } else {
          const i2vModelIds: Record<string, string> = {
            lite: "veo_3_1_i2v_lite",
            fast_ultra: "veo_3_1_i2v_s_fast_ultra",
            lite_low_priority: "veo_3_1_i2v_lite_low_priority",
          };
          spec.model = i2vModelIds[String(params.video_quality)] ?? `veo_3_1_i2v_${params.video_quality}`;
        }
      }
    }
  } else if (type === "gen_video_omni") {
    const isT2V = params.video_mode === "t2v";
    spec = {
      type: isT2V ? "t2v" : "r2v",
      family: "omni_flash",
      prompt: params.prompt,
      aspect: params.aspect_ratio === "VIDEO_ASPECT_RATIO_PORTRAIT" ? "9:16" : "16:9",
      ref_media_ids: params.ref_media_ids || [],
      extract_video_ids: params.extract_video_ids || [],
      duration: params.duration_s,
      resolution: params.resolution || "720p",
      count: Number(params.variant_count) || 1,
    };
    if (params.duration_s) {
      spec.model = isT2V
        ? `abra_t2v_${params.duration_s}s${params.resolution === "360p" ? "_360p" : ""}`
        : `abra_r2v_${params.duration_s}s${params.resolution === "360p" ? "_360p" : ""}`;
    }
  } else if (type === "gen_image") {
    let aspect = "16:9";
    if (params.aspect_ratio === "IMAGE_ASPECT_RATIO_PORTRAIT") aspect = "9:16";
    else if (params.aspect_ratio === "IMAGE_ASPECT_RATIO_SQUARE") aspect = "1:1";
    spec = {
      type: "image",
      prompt: params.prompt,
      aspect,
      count: Number(params.variant_count) || 1,
      ref_media_ids: params.ref_media_ids || [],
      extract_video_ids: params.extract_video_ids || [],
      prompts: params.prompts,
    };
  } else if (type === "gen_video_extend") {
    // Extend an existing Veo clip (fZytfe). source_media_id is the video
    // to continue; prompt describes the next motion.
    spec = {
      type: "extend_video",
      model: "veo_3_1_extension_lite",
      family: "veo",
      prompt: params.prompt,
      source_media_id: params.source_media_id,
      aspect: params.aspect_ratio === "VIDEO_ASPECT_RATIO_PORTRAIT" ? "9:16" : "16:9",
      count: Number(params.variant_count) || 1,
    };
  } else if (type === "gen_video_video_reference") {
    // Edit one clip against a video reference (jIps6 / "abra_edit"). Omni
    // Flash only; `model` is left to the backend catalog so the wire id
    // (abra_edit) stays in one place.
    spec = {
      type: "video_reference",
      family: "omni_flash",
      prompt: params.prompt,
      source_media_id: params.source_media_id,
      ref_media_ids: params.ref_media_ids || [],
      aspect: params.aspect_ratio === "VIDEO_ASPECT_RATIO_PORTRAIT" ? "9:16" : "16:9",
      count: Number(params.variant_count) || 1,
    };
  } else {
    spec = {
      type: "image",
      prompt: params.prompt || "image",
      count: 1,
    };
  }

  const { useBoardStore } = await import("./board");
  const workspace_id = useBoardStore.getState().boardPublicId;
  return api("/api/canvas/requests", {
    method: "POST",
    body: { type, node_id, params, spec, workspace_id },
  });
}

export function getRequest(id: string | number): Promise<any> {
  return api(`/api/canvas/requests/${encodeURIComponent(String(id))}`);
}

export async function cancelCanvasRequest(id: string | number): Promise<{ id: string; status: string }> {
  return api(`/api/canvas/requests/${encodeURIComponent(String(id))}/cancel`, {
    method: "POST",
  });
}

/**
 * Stop a node AND every node that transitively depends on it.
 *
 * Scope comes from the dependency graph on the backend; `stopped` reports the
 * state each affected node was left in: `idle` (it was still queued, never
 * ran) or `canceled` (it was mid-generation, stays retryable).
 */
export async function stopCanvasChain(
  boardId: number,
  nodeId: number,
): Promise<{ stopped: { id: number; status: string }[] }> {
  return api(`/api/boards/${boardId}/nodes/${nodeId}/stop-chain`, { method: "POST" });
}

/** Stop every running/queued node of the project (header Stop All). */
export async function stopCanvasBoard(
  boardId: number,
): Promise<{ stopped: { id: number; status: string }[] }> {
  return api(`/api/boards/${boardId}/stop-all`, { method: "POST" });
}

export async function listBoardRequests(boardId?: number, _opts?: any): Promise<{ items: any[] }> {
  if (boardId === undefined) return { items: [] };
  return api(`/api/boards/${boardId}/requests`);
}

// ── Reference library ──────────────────────────────────────────────────

export interface ReferenceCreateInput {
  media_id: string;
  kind: "image" | "character" | "visual_asset" | "storyboard_shot";
  ai_brief?: string | null;
  aspect_ratio?: string | null;
  label?: string | null;
  source_board_id?: number | null;
  source_node_short_id?: string | null;
}

export interface ReferenceItem {
  id: number;
  mediaId: string;
  kind: ReferenceCreateInput["kind"];
  aiBrief: string | null;
  aspectRatio: string | null;
  label: string;
  sourceBoardId: number | null;
  sourceNodeShortId: string | null;
  pinned: boolean;
  position: number;
  createdAt: string;
}

export function createReference(input: ReferenceCreateInput): Promise<ReferenceItem> {
  return api<ReferenceItem>("/api/references", { method: "POST", body: input });
}

export async function deleteReference(id: number): Promise<void> {
  await api(`/api/references/${id}`, { method: "DELETE" });
}

export function listReferences(options: { limit?: number } = {}): Promise<ReferenceItem[]> {
  const query = options.limit ? `?limit=${options.limit}` : "";
  return api<ReferenceItem[]>(`/api/references${query}`);
}

export function patchReference(
  id: number,
  patch: { label?: string; pinned?: boolean },
): Promise<ReferenceItem> {
  return api<ReferenceItem>(`/api/references/${id}`, { method: "PATCH", body: patch });
}
