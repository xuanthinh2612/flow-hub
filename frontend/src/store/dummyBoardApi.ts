/**
 * Local-only mock of the flowboard backend API.
 *
 * Nodes and edges live in-memory so the canvas operates fully
 * client-side while still satisfying the same store contract as the
 * real flowboard backend.
 */

export type NodeType = "image" | "video" | "prompt" | "character" | "visual_asset" | "Storyboard" | "note" | "merge";

export interface Board {
  id: number;
  name: string;
  project_id: string;
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

const STORAGE_BOARDS = "flowhub.canvas.boards.v2";
const STORAGE_NODES = "flowhub.canvas.nodes.v2";
const STORAGE_EDGES = "flowhub.canvas.edges.v2";

function loadStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveStorage(key: string, val: any) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

const _boards: Board[] = loadStorage(STORAGE_BOARDS, [{ id: 1, name: "Canvas", project_id: "default" }]);
const _nodes: StoredNode[] = loadStorage(STORAGE_NODES, []);
const _edges: StoredEdge[] = loadStorage(STORAGE_EDGES, []);

let _nextId = Math.max(100, ..._boards.map((b) => b.id), ..._nodes.map((n) => n.id), ..._edges.map((e) => e.id)) + 1;
function nextId(): number { return _nextId++; }

// ── Board CRUD ─────────────────────────────────────────────────────────

export async function listBoards(): Promise<Board[]> {
  return _boards;
}

export async function createBoard(name: string): Promise<Board> {
  const board: Board = { id: nextId(), name, project_id: "default" };
  _boards.push(board);
  saveStorage(STORAGE_BOARDS, _boards);
  return board;
}

export async function getBoard(id: number): Promise<{
  board: Board;
  nodes: StoredNode[];
  edges: StoredEdge[];
}> {
  const board = _boards.find((b) => b.id === id) ?? _boards[0];
  return {
    board,
    nodes: _nodes.filter((n) => n.board_id === board.id),
    edges: _edges.filter((e) => e.board_id === board.id),
  };
}

export async function patchBoard(id: number, name: string): Promise<Board> {
  const board = _boards.find((b) => b.id === id);
  if (board) {
    board.name = name;
    saveStorage(STORAGE_BOARDS, _boards);
  }
  return board ?? { id, name, project_id: "default" };
}

export async function deleteBoard(id: number): Promise<void> {
  const idx = _boards.findIndex((b) => b.id === id);
  if (idx >= 0) {
    _boards.splice(idx, 1);
    saveStorage(STORAGE_BOARDS, _boards);
  }
}

// ── Node CRUD ──────────────────────────────────────────────────────────

export async function createNode(input: {
  board_id: number;
  type: string;
  x: number;
  y: number;
  data: Record<string, unknown>;
}): Promise<StoredNode> {
  const id = nextId();
  const node: StoredNode = {
    id,
    board_id: input.board_id,
    type: input.type as NodeType,
    short_id: `n${id}`,
    status: ((input.data?.status as string) ?? "idle") as NodeStatus,
    x: input.x,
    y: input.y,
    data: input.data ?? {},
  };
  _nodes.push(node);
  saveStorage(STORAGE_NODES, _nodes);
  return node;
}

export async function patchNode(
  id: number,
  patch: Record<string, any>,
): Promise<StoredNode | null> {
  const node = _nodes.find((n) => n.id === id);
  if (!node) return null;
  if (patch.x !== undefined) node.x = patch.x;
  if (patch.y !== undefined) node.y = patch.y;
  if (patch.status !== undefined) node.status = patch.status;
  if (patch.data) Object.assign(node.data, patch.data);
  saveStorage(STORAGE_NODES, _nodes);
  return node;
}

export async function deleteNode(id: number): Promise<void> {
  const idx = _nodes.findIndex((n) => n.id === id);
  if (idx >= 0) _nodes.splice(idx, 1);
  // Clean up edges referencing this node
  for (let i = _edges.length - 1; i >= 0; i--) {
    if (_edges[i].source_id === id || _edges[i].target_id === id) {
      _edges.splice(i, 1);
    }
  }
  saveStorage(STORAGE_NODES, _nodes);
  saveStorage(STORAGE_EDGES, _edges);
}

// ── Edge CRUD ──────────────────────────────────────────────────────────

export async function createEdge(input: {
  board_id: number;
  source_id: number;
  target_id: number;
}): Promise<StoredEdge> {
  const id = nextId();
  const edge: StoredEdge = {
    id,
    board_id: input.board_id,
    source_id: input.source_id,
    target_id: input.target_id,
    source_variant_idx: null,
  };
  _edges.push(edge);
  saveStorage(STORAGE_EDGES, _edges);
  return edge;
}

export async function deleteEdge(id: number): Promise<void> {
  const idx = _edges.findIndex((e) => e.id === id);
  if (idx >= 0) {
    _edges.splice(idx, 1);
    saveStorage(STORAGE_EDGES, _edges);
  }
}

import { api } from "../api/client";
import type { JobItem } from "../api/types";

// ── Project / request integration ──────────────────────────────────────

export async function ensureBoardProject(_boardId?: number): Promise<{ flow_project_id: string }> {
  return { flow_project_id: "default" };
}

interface CanvasRequestRecord {
  id: number;
  jobId: string;
  type: string;
  nodeId?: number;
  params: Record<string, any>;
  createdAt: number;
}

const STORAGE_REQUESTS = "flowhub.canvas.requests.v2";
const _requests: CanvasRequestRecord[] = loadStorage(STORAGE_REQUESTS, []);

export async function createRequest(input: {
  type: string;
  node_id?: number;
  params: Record<string, any>;
}): Promise<any> {
  const { type, node_id, params } = input;
  let spec: Record<string, any>;

  if (type === "gen_video_text") {
    spec = {
      type: "t2v",
      prompt: params.prompt,
      aspect: params.aspect_ratio === "VIDEO_ASPECT_RATIO_PORTRAIT" ? "9:16" : "16:9",
      count: Number(params.variant_count) || 1,
    };
  } else if (type === "gen_video") {
    const startIds = (Array.isArray(params.start_media_ids) && params.start_media_ids.length > 0)
      ? params.start_media_ids
      : params.start_media_id ? [params.start_media_id] : [];
    spec = {
      type: "i2v",
      prompt: params.prompt,
      aspect: params.aspect_ratio === "VIDEO_ASPECT_RATIO_PORTRAIT" ? "9:16" : "16:9",
      count: startIds.length || 1,
      start_media_ids: startIds,
    };
  } else if (type === "gen_video_omni") {
    spec = {
      type: "r2v",
      prompt: params.prompt,
      aspect: params.aspect_ratio === "VIDEO_ASPECT_RATIO_PORTRAIT" ? "9:16" : "16:9",
      ref_media_ids: params.ref_media_ids || [],
      duration: params.duration_s ? `${params.duration_s}s` : undefined,
    };
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
      prompts: params.prompts,
    };
  } else {
    spec = {
      type: "image",
      prompt: params.prompt || "image",
      count: 1,
    };
  }

  const job = await api<{ id: string }>("/api/jobs", {
    method: "POST",
    body: spec,
  });

  const reqId = nextId();
  const reqRecord: CanvasRequestRecord = {
    id: reqId,
    jobId: job.id,
    type,
    nodeId: node_id,
    params,
    createdAt: Date.now(),
  };
  _requests.push(reqRecord);
  saveStorage(STORAGE_REQUESTS, _requests);

  return {
    id: reqId,
    status: "running",
    type,
    params,
    result: {},
    error: null,
  };
}

export async function getRequest(id: number): Promise<any> {
  const record = _requests.find((r) => r.id === id);
  if (!record) {
    return { id, status: "failed", type: "", params: {}, result: {}, error: "Không tìm thấy request" };
  }

  try {
    const job = await api<JobItem>(`/api/jobs/${record.jobId}`);
    const isDone = job.status === "done";
    const isPartial = job.status === "partial";
    const isFailed = job.status === "failed" || job.status === "timeout" || job.status === "canceled";
    const isRunning = job.status === "running" || job.status === "polling" || job.status === "queued";

    const mediaIds = (job.results || []).map((r) => r.media_id);

    let status = "running";
    if (isDone || isPartial) status = "done";
    else if (isFailed) status = "failed";
    else if (isRunning) status = "running";

    return {
      id,
      type: record.type,
      status,
      params: record.params,
      result: {
        media_ids: mediaIds,
        partial_error: job.error,
      },
      error: job.error,
    };
  } catch (err: any) {
    return {
      id,
      type: record.type,
      status: "running",
      params: record.params,
      result: {},
      error: err?.message,
    };
  }
}

export async function listBoardRequests(_boardId?: number, _opts?: any): Promise<{ items: any[] }> {
  return { items: _requests };
}

// ── Pipeline stubs ─────────────────────────────────────────────────────

export type PipelineRunDTO = any;
export async function runPlan(..._args: any[]): Promise<any> { return { status: "completed" }; }
export async function getPipelineRun(..._args: any[]): Promise<any> { return { status: "completed" }; }

// ── Reference stubs ────────────────────────────────────────────────────

export type ReferenceCreateInput = any;
export type ReferenceItem = any;
export async function createReference(..._args: any[]): Promise<any> { return {}; }
export async function deleteReference(..._args: any[]): Promise<any> { return {}; }
export async function listReferences(..._args: any[]): Promise<any[]> { return []; }
export async function patchReference(..._args: any[]): Promise<any> { return {}; }
