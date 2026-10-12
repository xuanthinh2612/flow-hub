import { create } from "zustand";
import type { Edge, Node, Viewport } from "@xyflow/react";
import { cancelPendingNodeGeneration, writeNodeGeneration } from "../utils/nodeGenerationSettings";
import { useSettingsStore } from "./settings";
import {
  listBoards,
  createBoard,
  getBoard,
  patchBoard as apiPatchBoard,
  deleteBoard as apiDeleteBoard,
  createNode,
  patchNode,
  deleteNode,
  createEdge,
  patchEdge,
  deleteEdge,
  type Board,
  type NodeType,
  type StoredEdge,
} from "./boardApi";

export type { NodeType };

export type NodeStatus = "idle" | "queued" | "running" | "done" | "error";

// Storyboard grid options.
//   2x2 → 4 panels (square)
//   2x3 → 6 panels (rectangular: 2×3 on landscape, 3×2 on portrait)
//   2x4 → 8 panels (rectangular: 2×4 on landscape, 4×2 on portrait)
// The rows/cols mapping happens at prompt-build time based on the
// node's aspectRatio — see resolveStoryboardLayout in
// frontend/src/lib/storyboardPrompt.ts.
export type StoryboardGrid = "2x2" | "2x3" | "2x4";

export interface NodeGeneration extends Record<string, unknown> {
  backend?: "flow" | "muse";
  aspectRatio?: string;
  model?: { id?: string; family: string; quality?: string };
  resolution?: string | null;
  duration?: number | null;
  camera?: "static" | "dynamic";
  videoMode?: "t2v" | "i2v" | "r2v";
  operation?: string;
  prompts?: string[];
  prompt?: string;
  variants?: number;
  storyboardGrid?: StoryboardGrid;
  charCountry?: string | null;
  charGender?: string | null;
  charVibe?: string;
  charExtras?: string;
  selectedSourceIdx?: number[];
  independentVideoMediaIds?: string[];
  independentVideoMode?: "i2v" | "r2v";
  connectedVideoMode?: "i2v" | "r2v";
  r2vAdditionalMediaIds?: string[];
  t2vLibraryMediaId?: string | null;
  t2vLibraryMediaItem?: unknown;
  t2vSourceId?: string;
}

export interface FlowboardNodeData extends Record<string, unknown> {
  type: NodeType;
  shortId: string;
  title: string;
  status?: NodeStatus;
  generation?: NodeGeneration;
  thumbnailUrl?: string;
  mediaId?: string;
  // Per-variant media ids in dispatch order. `null` entries are
  // positional placeholders for variants that failed (e.g. Veo content
  // filter blocked one of the 4 i2v clips while the other 3 succeeded);
  // keeping the slot preserves alignment with the upstream image's
  // variants for poster/edge-pin lookups.
  mediaIds?: (string | null)[];
  // Per-slot error code, aligned to `mediaIds` indexing. `null` for
  // succeeded slots, an error string (e.g. "PUBLIC_ERROR_UNSAFE_GENERATION")
  // for blocked ones. ResultViewer reads this to render the exact
  // filter reason on the blocked tile instead of falling through to
  // the previous variant.
  slotErrors?: (string | null)[];
  variantCount?: number;
  // The aspect-ratio enum the asset was generated / uploaded at — used to
  // default-match downstream gen dialogs (e.g. a 9:16 visual_asset feeds
  // into a downstream image / video that defaults to 9:16). Values are
  // Flow's IMAGE_ASPECT_RATIO_* enum strings since that's what the upload
  // route + gen worker produce. Video targets map them onto the matching
  // VIDEO_ASPECT_RATIO_* enum at dialog-open time.
  aspectRatio?: string;
  // AI-generated factual description of mediaId (set by /api/vision/describe).
  // Spliced into auto-prompts on downstream nodes for richer context.
  aiBrief?: string;
  aiBriefStatus?: "pending" | "done" | "failed";
  // Transient status while the GenerationDialog runs `autoPrompt` /
  // `autoPromptBatch` against this node — set to "pending" while the
  // backend is composing the prompt, cleared on success/failure. Not
  // persisted to the DB; it's a few-second UX flag so the node can
  // render a visible "busy" treatment that blocks duplicate dispatches.
  autoPromptStatus?: "pending" | "done" | "failed";
  // ISO timestamp persisted when a generation completes successfully.
  // Powers the "5 phút trước" relative-time display in ResultViewer.
  // Uploads also stamp this so the timestamp reflects "when the asset
  // landed on the node" regardless of source.
  renderedAt?: string;
  // Model used to produce the rendered media. Populated on completion
  // of gen_image / edit_image (`imageModel`, e.g. "NANO_BANANA_PRO") or
  // gen_video (`videoQuality`, e.g. "fast" / "lite" / "quality"). Absent
  // on uploads (no model involved) and on nodes generated before this
  // feature shipped — ResultViewer falls back to current settings as
  // plain text in that case so the user knows it's an estimate.
  imageModel?: string;
  videoQuality?: string;
  // Character-builder selections — persisted on dispatch so the detail
  // panel can show "Country / Vibe / Gender" pills under METADATA. Keys
  // (`vn`, `clean`, `female`) match the constants in
  // `src/constants/character.ts`; viewer maps key → display label.
  error?: string;
  // Storyboard layout. The Storyboard node is now a thin image-node
  // wrapper that generates a single composite using a locked prompt
  // template `Create visual storyboard for "<topic>" as SINGLE IMAGE
  // arranged in a NxN layout (N rows, N columns)`. Default `3x3` when
  // missing (true for fresh nodes + legacy pre-1.2.15 nodes whose
  // multi-shot data is now ignored).
}

export type FlowNode = Node<FlowboardNodeData>;

const isDatabaseId = (id: string) => /^\d+$/.test(id);

function defaultNodeGeneration(type: NodeType): NodeGeneration | undefined {
  const settings = useSettingsStore.getState();
  if (type === "video") {
    const model = settings.videoModel === "omni_flash"
      ? {
          family: "omni_flash",
          id: `abra_r2v_${settings.omniFlashDuration}s${settings.omniFlashResolution === "360p" ? "_360p" : ""}`,
        }
      : { family: "veo", quality: settings.videoQuality };
    return {
      backend: settings.mediaProvider,
      aspectRatio: "VIDEO_ASPECT_RATIO_LANDSCAPE",
      model,
      ...(settings.videoModel === "omni_flash"
        ? { duration: settings.omniFlashDuration, resolution: settings.omniFlashResolution }
        : {}),
      camera: "static",
      prompt: "",
      variants: 1,
      videoMode: "t2v",
    };
  }
  if (["image", "character", "visual_asset", "Storyboard"].includes(type)) {
    return {
      backend: settings.mediaProvider,
      aspectRatio: type === "character" ? "IMAGE_ASPECT_RATIO_SQUARE" : "IMAGE_ASPECT_RATIO_LANDSCAPE",
      model: { family: "image", id: settings.imageModel },
      prompt: "",
      variants: 1,
      ...(type === "character" ? { charGender: null, charCountry: null, charVibe: "clean", charExtras: "" } : {}),
      ...(type === "Storyboard" ? { storyboardGrid: "2x2" } : {}),
    };
  }
  return undefined;
}

const OBSOLETE_GENERATION_KEYS = [
  "generationConfig", "generationDraft", "prompt", "charCountry", "charVibe", "charGender", "charExtras",
  "storyboardGrid", "independentMediaIds", "independentVideoMode", "connectedVideoMode",
  "r2vAdditionalMediaIds", "t2vSourceId",
] as const;

function migrateNodeGeneration(type: NodeType, data: Record<string, unknown>): NodeGeneration {
  const draft = data.generationDraft && typeof data.generationDraft === "object"
    ? data.generationDraft as Record<string, unknown>
    : {};
  const previous = data.generationConfig && typeof data.generationConfig === "object"
    ? data.generationConfig as Record<string, unknown>
    : {};
  const defaults = defaultNodeGeneration(type) ?? {};
  const previousModel = previous.model && typeof previous.model === "object"
    ? previous.model as Record<string, unknown>
    : {};
  const isVideo = type === "video";
  const videoFamily = draft.videoModel === "omni_flash" || previousModel.family === "omni_flash"
    ? "omni_flash"
    : "veo";
  const isImageGenerator = ["image", "character", "Storyboard"].includes(type);
  const imageModelId = typeof draft.imageModel === "string"
    ? draft.imageModel
    : typeof previousModel.id === "string" && previousModel.family === "image"
      ? previousModel.id
      : (defaults.model as NodeGeneration["model"])?.id;
  const duration = draft.omniFlashDuration ?? previous.duration ?? defaults.duration;
  const resolution = draft.omniFlashResolution ?? previous.resolution ?? defaults.resolution;
  const quality = draft.videoQuality ?? previousModel.quality ?? (defaults.model as NodeGeneration["model"])?.quality;
  const model = isVideo
    ? videoFamily === "omni_flash"
      ? {
          family: "omni_flash",
          id: `abra_r2v_${Number(duration ?? 8)}s${String(resolution ?? "720p") === "360p" ? "_360p" : ""}`,
        }
      : { family: "veo", ...(typeof quality === "string" ? { quality } : {}) }
    : isImageGenerator ? { family: "image", ...(typeof imageModelId === "string" ? { id: imageModelId } : {}) } : undefined;
  const videoMode = draft.connectedVideoMode ?? draft.independentVideoMode
    ?? data.connectedVideoMode ?? data.independentVideoMode ?? previous.videoMode ?? defaults.videoMode;
  return {
    ...defaults,
    ...previous,
    prompt: typeof draft.prompt === "string" ? draft.prompt : typeof data.prompt === "string" ? data.prompt : "",
    backend: (draft.backend ?? previous.backend ?? defaults.backend) as NodeGeneration["backend"],
    aspectRatio: String(draft.aspectRatio ?? previous.aspectRatio ?? defaults.aspectRatio ?? (isVideo ? "VIDEO_ASPECT_RATIO_LANDSCAPE" : "IMAGE_ASPECT_RATIO_LANDSCAPE")),
    ...(model ? { model } : {}),
    ...(isVideo && videoFamily === "omni_flash" ? { duration: Number(duration ?? 8), resolution: String(resolution ?? "720p") } : { duration: null, resolution: null }),
    camera: (draft.camera ?? previous.camera ?? "static") as NodeGeneration["camera"],
    ...(typeof videoMode === "string" ? { videoMode: videoMode as NodeGeneration["videoMode"] } : {}),
    variants: Number(draft.variants ?? data.variantCount ?? 1),
    ...(Array.isArray(previous.prompts) || Array.isArray(draft.prompts) ? { prompts: (draft.prompts ?? previous.prompts) as string[] } : {}),
    charGender: (draft.charGender ?? data.charGender ?? null) as string | null,
    charCountry: (draft.charCountry ?? data.charCountry ?? null) as string | null,
    charVibe: String(draft.charVibe ?? data.charVibe ?? (type === "character" ? "clean" : "")),
    charExtras: String(draft.charExtras ?? data.charExtras ?? ""),
    storyboardGrid: (draft.storyboardGrid ?? data.storyboardGrid ?? (type === "Storyboard" ? "2x2" : undefined)) as StoryboardGrid | undefined,
    selectedSourceIdx: Array.isArray(draft.selectedSourceIdx) ? draft.selectedSourceIdx as number[] : [],
    independentVideoMediaIds: (draft.independentVideoMediaIds ?? data.independentMediaIds ?? []) as string[],
    independentVideoMode: (draft.independentVideoMode ?? data.independentVideoMode ?? "i2v") as "i2v" | "r2v",
    connectedVideoMode: (draft.connectedVideoMode ?? data.connectedVideoMode ?? "i2v") as "i2v" | "r2v",
    r2vAdditionalMediaIds: (draft.r2vAdditionalMediaIds ?? data.r2vAdditionalMediaIds ?? []) as string[],
    t2vLibraryMediaId: (draft.t2vLibraryMediaId ?? null) as string | null,
    t2vLibraryMediaItem: draft.t2vLibraryMediaItem,
    t2vSourceId: typeof data.t2vSourceId === "string" ? data.t2vSourceId : undefined,
  };
}

async function mapStoredCanvasNodes(rows: Array<{ id: number; type: NodeType; x: number; y: number; short_id: string; status: NodeStatus; data: Record<string, unknown> }>): Promise<FlowNode[]> {
  const migrations: Array<{ id: number; data: Record<string, unknown> }> = [];
  const nodes = rows.map((row) => {
    const existingGeneration = row.data.generation;
    const needsMigration = !existingGeneration || typeof existingGeneration !== "object";
    const generation = needsMigration ? migrateNodeGeneration(row.type, row.data) : existingGeneration as NodeGeneration;
    const data = { ...row.data, generation };
    if (needsMigration) {
      const cleanup = Object.fromEntries(OBSOLETE_GENERATION_KEYS.map((key) => [key, null]));
      migrations.push({ id: row.id, data: { ...cleanup, generation } });
    }
    return {
      id: String(row.id),
      type: row.type,
      position: { x: row.x, y: row.y },
      data: {
        ...data,
        type: row.type,
        shortId: row.short_id,
        title: (row.data.title as string | undefined) ?? TYPE_TITLE[row.type],
        status: row.status,
      },
    };
  });
  for (let index = 0; index < migrations.length; index += 8) {
    const batch = migrations.slice(index, index + 8);
    await Promise.all(batch.map(({ id, data }) => patchNode(id, { data }).catch((error) => {
      console.warn(`Could not migrate node ${id} to canonical generation settings`, error);
    })));
  }
  return nodes;
}

function mergeProjectDraft(
  mappedNodes: FlowNode[],
  storedEdges: StoredEdge[],
): { nodes: FlowNode[]; edges: Edge[] } {
  return { nodes: mappedNodes, edges: storedEdges.map(edgeFromDto) };
}

// Per-edge data we attach to ReactFlow's `Edge.data` so dispatch and
// edge-rendering paths can read it without a round-trip through the
// backend. `sourceVariantIdx` mirrors `EdgeDTO.source_variant_idx`.
export interface FlowboardEdgeData extends Record<string, unknown> {
  sourceVariantIdx?: number | null;
}

/** Map an EdgeDTO from the backend into ReactFlow's Edge shape, carrying
 * the variant pin through `data` so dispatch + edge UI can read it. */
function edgeFromDto(dto: {
  id: number;
  source_id: number;
  target_id: number;
  source_variant_idx?: number | null;
}): Edge<FlowboardEdgeData> {
  return {
    id: String(dto.id),
    source: String(dto.source_id),
    target: String(dto.target_id),
    data: { sourceVariantIdx: dto.source_variant_idx ?? null },
  };
}

// ── Reload resume ─────────────────────────────────────────────────────────
// A board's nodes now carry their real in-flight status from the DB (the
// worker writes it — see agent/flowboard/worker/processor.py), so a node
// that was generating when the tab reloaded comes back rendering as busy.
// Nothing re-attaches THIS page's poll loop to it though, so without the
// call below the card would sit on the processing UI until the generation's
// result was noticed by some later reload. Fire-and-forget: a board that
// can't resume is still fully usable.
//
// Dynamic import for the same reason deleteNodeByRfId uses one — the
// generation store imports this one, and a static import here would close
// the cycle at module init.
async function resumeActiveGenerations(boardId: number): Promise<void> {
  try {
    const { useGenerationStore } = await import("./generation");
    await useGenerationStore.getState().resumeActiveRequests(boardId);
  } catch {
    // Module not loaded (tree-shaken test path) or the fetch failed.
  }
}

// ── Tiny per-node debounce (no external deps) ─────────────────────────────
// ── Type-to-title lookup ───────────────────────────────────────────────────
const TYPE_TITLE: Record<NodeType, string> = {
  character: "Character",
  image: "Image",
  video: "Video",
  prompt: "Prompt",
  note: "Note",
  visual_asset: "Visual asset",
  Storyboard: "Storyboard",
  merge: "Merge",
};

// ── Persisted active-board id ─────────────────────────────────────────────
// Survives page reloads so refreshing on project #4 doesn't kick the user
// back to project #1. localStorage is fine here — single-user, single-host.
const ACTIVE_BOARD_KEY = "flowboard.activeBoardId";
const ACTIVE_PROJECT_KEY = "flowboard.activeProjectId";

function loadPersistedBoardId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_BOARD_KEY);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function persistBoardId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_BOARD_KEY);
    else localStorage.setItem(ACTIVE_BOARD_KEY, String(id));
  } catch {
    // Storage disabled / quota exceeded — non-fatal, just lose persistence.
  }
}

function persistProjectId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_PROJECT_KEY);
    else localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  } catch { /* Storage disabled / quota exceeded — non-fatal. */ }
}

// ── Store ──────────────────────────────────────────────────────────────────
interface BoardState {
  boardId: number | null;
  boardPublicId: string | null;
  boardName: string;
  viewport: Viewport | null;
  // Lightweight summary list rendered by the ProjectSidebar — full node /
  // edge content lives only on the active board to keep memory bounded.
  boards: Board[];
  nodes: FlowNode[];
  edges: Edge[];
  loading: boolean;
  error: string | null;

  loadInitialBoard(requestedId?: number): Promise<void>;
  refreshBoardState(): Promise<void>;
  refreshBoardList(): Promise<void>;
  renameBoard(name: string): Promise<void>;
  persistViewport(viewport: Viewport): Promise<void>;
  // Switch the active board: load detail, replace nodes/edges, reset
  // poll-state on the generation store.
  switchBoard(id: number): Promise<void>;
  // Create a new board, switch to it, return id.
  createNewBoard(name: string): Promise<number | null>;
  // Delete a board. If it's the active one, switch to first remaining
  // board (or create a fresh "Untitled" if list ends up empty).
  deleteBoardById(id: number): Promise<void>;

  // Returns the new node's rfId on success, or null if creation failed.
  // Callers that need to wire up an edge immediately (e.g. drop-popover
  // shortcut) need the id back synchronously.
  addNodeOfType(type: NodeType, position: { x: number; y: number }): Promise<string | null>;
  promoteNodeForGeneration(rfId: string): Promise<string | null>;
  // Spawn a brand-new visual_asset node from a saved Reference. Used by
  // both the panel click-to-spawn path and the canvas drop-to-spawn path.
  // The new node lands with status="done" + mediaId + aiBrief already
  // populated so its thumbnail loads immediately and it can be used as a
  // downstream ref without any extra round-trip.
  addReferenceNode(
    ref: {
      mediaId: string;
      aiBrief?: string | null;
      aspectRatio?: string | null;
      kind: string;
      label: string;
    },
    position: { x: number; y: number },
  ): Promise<string | null>;
  persistNodePosition(rfId: string, position: { x: number; y: number }): Promise<void>;
  deleteNodeByRfId(rfId: string): Promise<void>;
  addEdgeFromConnection(source: string, target: string): Promise<void>;
  deleteEdgeByRfId(rfId: string): Promise<void>;
  // Spawn an empty sibling node next to `rfId` with the same type and the
  // same upstream edges. Returns the new node's rfId so callers can focus
  // / open the generation dialog on it. Used by ResultViewer's
  // "New variant +" — gives the user a fresh canvas to gen another shot
  // sharing the original's source refs.
  cloneNodeWithUpstream(rfId: string): Promise<string | null>;

  updateNodeData(rfId: string, partial: Partial<FlowboardNodeData>): void;
  updateNodeGeneration(rfId: string, partial: NodeGeneration): void;
  /** Merge `partial` into edge.data — used to refresh the local cache
   * after a PATCH /api/edges/{id} so the badge updates without waiting
   * for a full board refresh. */
  updateEdgeData(edgeId: string, partial: Partial<FlowboardEdgeData>): void;
  setNodes(nodes: FlowNode[]): void;
  setEdges(edges: Edge[]): void;
  clearError(): void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  boardId: null,
  boardPublicId: null,
  boardName: "",
  viewport: null,
  boards: [],
  nodes: [],
  edges: [],
  loading: false,
  error: null,

  async loadInitialBoard(requestedId) {
    const changingWorkspace = requestedId !== undefined && get().boardId !== requestedId;
    set({ loading: true, error: null, ...(changingWorkspace ? { boardId: null, boardPublicId: null, boardName: "", viewport: null, nodes: [], edges: [] } : {}) });
    if (changingWorkspace) {
      void import("./generation").then(({ useGenerationStore }) => {
        useGenerationStore.getState().closeGenerationDialog();
        useGenerationStore.getState().closeResultViewer();
        useGenerationStore.setState({ projectId: null });
      });
    }
    try {
      const boards = await listBoards();
      if (requestedId !== undefined && !boards.some((b: any) => b.id === requestedId)) {
        set({ loading: false, boards, boardId: null, boardPublicId: null, viewport: null, nodes: [], edges: [] });
        return;
      }
      // Prefer the user's last-active board if it still exists; fall back
      // to the first board in the list. Without this, refresh always
      // snapped back to boards[0] regardless of what was selected before.
      const persistedId = loadPersistedBoardId();
      let board = (requestedId !== undefined && boards.find((b: any) => b.id === requestedId)) ||
        (persistedId !== null && boards.find((b: any) => b.id === persistedId)) || boards[0];
      if (!board) {
        set({ loading: false, boards, boardId: null, boardPublicId: null, viewport: null, nodes: [], edges: [] });
        return;
      }
      const detail = await getBoard(board.id);

      const mappedNodes = await mapStoredCanvasNodes(detail.nodes as any);

      const { nodes, edges } = mergeProjectDraft(mappedNodes, detail.edges);

      set({
        boardId: detail.board.id,
        boardPublicId: detail.board.public_id,
        boardName: detail.board.name,
        viewport: detail.board.viewport ?? null,
        boards,
        nodes,
        edges,
        loading: false,
      });
      persistBoardId(detail.board.id);
      persistProjectId(detail.board.public_id);
      // `ensureProjectId` resolves per board but caches globally, so without
      // this a board change would dispatch under the previous board's project.
      // Harmless while every board shares one Flow project, which is all Flow
      // still allows — but it is the same stale-binding bug, and a latent one
      // is still one.
      void import("./generation").then(({ useGenerationStore }) => {
        useGenerationStore.setState({ projectId: null });
      });
      void resumeActiveGenerations(detail.board.id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async refreshBoardList() {
    try {
      const boards = await listBoards();
      set({ boards });
    } catch {
      // non-fatal
    }
  },

  async switchBoard(id) {
    if (id === get().boardId) return;
    set({ loading: true, error: null });
    try {
      const detail = await getBoard(id);
      const mappedNodes = await mapStoredCanvasNodes(detail.nodes as any);
      const { nodes, edges } = mergeProjectDraft(mappedNodes, detail.edges);
      set({
        boardId: detail.board.id,
        boardPublicId: detail.board.public_id,
        boardName: detail.board.name,
        viewport: detail.board.viewport ?? null,
        nodes,
        edges,
        loading: false,
      });
      persistBoardId(detail.board.id);
      persistProjectId(detail.board.public_id);
      // `ensureProjectId` resolves per board but caches globally, so without
      // this a board change would dispatch under the previous board's project.
      // Harmless while every board shares one Flow project, which is all Flow
      // still allows — but it is the same stale-binding bug, and a latent one
      // is still one.
      void import("./generation").then(({ useGenerationStore }) => {
        useGenerationStore.setState({ projectId: null });
      });
      void resumeActiveGenerations(detail.board.id);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async createNewBoard(name) {
    try {
      const board = await createBoard(name || "Untitled");
      // Add to list (front of list so the newly-created project shows up
      // at the top of the sidebar) and switch to it.
      set((s) => ({ boards: [board, ...s.boards] }));
      await get().switchBoard(board.id);
      return board.id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  async deleteBoardById(id) {
    try {
      await apiDeleteBoard(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const remaining = get().boards.filter((b: any) => b.id !== id);
    set({ boards: remaining });
    // If we just deleted the active board, switch to the first remaining
    // board — or create a fresh "Untitled" if none left.
    if (get().boardId === id) {
      if (remaining.length > 0) {
        await get().switchBoard(remaining[0].id);
      } else {
        set({ boardId: null, boardPublicId: null, boardName: "", viewport: null, nodes: [], edges: [] });
        persistBoardId(null);
        persistProjectId(null);
      }
    }
  },

  async refreshBoardState() {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const detail = await getBoard(boardId);
      const mappedNodes = await mapStoredCanvasNodes(detail.nodes as any);
      const { nodes, edges } = mergeProjectDraft(mappedNodes, detail.edges);
      set({ nodes, edges });
      // Same reason as loadInitialBoard / switchBoard: this path replaces the
      // node list wholesale from the DB, so anything in flight comes back
      // rendering as busy with no poll attached. `resumeActiveRequests`
      // skips nodes a live poll already owns, so calling it on every refresh
      // re-attaches only what actually lost its watcher.
      void resumeActiveGenerations(boardId);
    } catch {
      // ignore — leave state alone, next poll will retry
    }
  },

  async renameBoard(name: string) {
    const { boardId } = get();
    if (boardId === null) return;
    try {
      const updated = await apiPatchBoard(boardId, { name });
      set((s) => ({
        boardName: updated.name,
        boards: s.boards.map((b: any) =>
          b.id === boardId ? { ...b, name: updated.name } : b,
        ),
      }));
    } catch {
      // non-fatal; keep local name
    }
  },

  async persistViewport(viewport) {
    const { boardId } = get();
    if (boardId === null) return;
    set({ viewport });
    try { await apiPatchBoard(boardId, { viewport }); } catch { /* best effort */ }
  },

  async addNodeOfType(type, position) {
    const { boardId, boardPublicId } = get();
    if (boardId === null || !boardPublicId) return null;
    const title = TYPE_TITLE[type as NodeType];
    const generation = defaultNodeGeneration(type);
    try {
      const dto = await createNode({
        board_id: boardId,
        type,
        x: Math.round(position.x),
        y: Math.round(position.y),
        data: {
          type,
          shortId: "",
          title,
          status: "idle",
          ...(generation ? { generation } : {}),
        },
      });
      const node: FlowNode = {
        id: String(dto.id), type, position: { x: dto.x, y: dto.y },
        data: { ...dto.data, type, shortId: dto.short_id, title, status: dto.status },
      };
      set((s) => ({ nodes: [...s.nodes, node] }));
      return String(dto.id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Could not save node" });
      return null;
    }
  },

  async addReferenceNode(ref, position) {
    const { boardId, boardPublicId } = get();
    if (boardId === null || !boardPublicId) return null;
    const title = ref.label || "Reference";
    try {
      const data = {
        type: "visual_asset", shortId: "", title, status: "done", mediaId: ref.mediaId,
        aiBrief: ref.aiBrief ?? undefined, aspectRatio: ref.aspectRatio ?? undefined,
        renderedAt: new Date().toISOString(),
      };
      const dto = await createNode({ board_id: boardId, type: "visual_asset", x: Math.round(position.x), y: Math.round(position.y), data });
      const node: FlowNode = {
        id: String(dto.id), type: "visual_asset", position: { x: dto.x, y: dto.y },
        data: { ...dto.data, type: "visual_asset", shortId: dto.short_id, title, status: dto.status },
      };
      set((s) => ({ nodes: [...s.nodes, node] }));
      return String(dto.id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Could not save reference node" });
      return null;
    }
  },

  async promoteNodeForGeneration(rfId) {
    return isDatabaseId(rfId) ? rfId : null;
  },

  async persistNodePosition(rfId, position) {
    const dbId = parseInt(rfId, 10);
    if (!Number.isSafeInteger(dbId)) return;
    try {
      await patchNode(dbId, { x: Math.round(position.x), y: Math.round(position.y) });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Could not save node position" });
    }
  },

  async deleteNodeByRfId(rfId) {
    const deletingBoardId = get().boardId;
    const dbId = isDatabaseId(rfId) ? Number(rfId) : null;
    try {
      const { useGenerationStore } = await import("./generation");
      if (useGenerationStore.getState().openDialog.rfId === rfId) useGenerationStore.getState().closeGenerationDialog();
      useGenerationStore.getState().cancelGeneration(rfId);
      useGenerationStore.getState().cancelSidecarPoll(rfId);
    } catch { /* ignore when generation store isn't loaded */ }
    if (dbId !== null) {
      try { await deleteNode(dbId); } catch { return; }
    }
    if (deletingBoardId !== null) cancelPendingNodeGeneration(get().boardPublicId, rfId);
    set((s) => {
      const nodes = s.nodes.filter((node) => node.id !== rfId);
      const edges = s.edges.filter((edge) => edge.source !== rfId && edge.target !== rfId);
      return { nodes, edges };
    });
  },

  async addEdgeFromConnection(source, target) {
    const { boardId } = get();
    if (boardId === null || !get().nodes.some((node) => node.id === source) || !get().nodes.some((node) => node.id === target)) return;
    if (!isDatabaseId(source) || !isDatabaseId(target)) return;
    try {
      const dto = await createEdge({ board_id: boardId, source_id: Number(source), target_id: Number(target) });
      set((s) => ({ edges: [...s.edges, edgeFromDto(dto)] }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Could not save connection" });
    }
  },

  async cloneNodeWithUpstream(rfId) {
    const { boardId, nodes, edges } = get();
    if (boardId === null) return null;
    const source = nodes.find((node) => node.id === rfId);
    if (!source) return null;
    const baseTitle = source.data.title ?? TYPE_TITLE[source.data.type as NodeType];
    const title = baseTitle.endsWith("(variant)") ? baseTitle : `${baseTitle} (variant)`;
    const upstream = edges.filter((edge) => edge.target === rfId);
    try {
      const dto = await createNode({
        board_id: boardId,
        type: source.data.type,
        x: Math.round(source.position.x + 60),
        y: Math.round(source.position.y + 60),
        data: { type: source.data.type, shortId: "", title, status: "idle", ...(source.data.generation ? { generation: source.data.generation } : {}) },
      });
      const id = String(dto.id);
      const node: FlowNode = {
        id, type: source.data.type, position: { x: dto.x, y: dto.y },
        data: { ...dto.data, type: source.data.type, shortId: dto.short_id, title, status: dto.status },
      };
      const clonedEdges: Edge[] = [];
      for (const edge of upstream) {
        if (!isDatabaseId(edge.source)) continue;
        const saved = await createEdge({ board_id: boardId, source_id: Number(edge.source), target_id: dto.id });
        const sourceVariantIdx = edge.data?.sourceVariantIdx;
        if (typeof sourceVariantIdx === "number" || sourceVariantIdx === null) {
          await patchEdge(saved.id, { source_variant_idx: sourceVariantIdx });
        }
        clonedEdges.push(edgeFromDto({ ...saved, source_variant_idx: typeof sourceVariantIdx === "number" || sourceVariantIdx === null ? sourceVariantIdx : null }));
      }
      set((s) => ({ nodes: [...s.nodes, node], edges: [...s.edges, ...clonedEdges] }));
      return id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Could not clone node" });
      return null;
    }
  },

  async deleteEdgeByRfId(rfId) {
    const dbId = parseInt(rfId, 10);
    if (isNaN(dbId)) return;
    try {
      await deleteEdge(dbId);
      set((s) => ({ edges: s.edges.filter((e: any) => e.id !== rfId) }));
    } catch {
      // ignore
    }
  },

  updateNodeGeneration: (rfId, partial) => {
    const node = get().nodes.find((item) => item.id === rfId);
    const generation = { ...(node?.data.generation ?? {}), ...partial };
    set((s) => ({ nodes: s.nodes.map((item) => item.id === rfId
      ? { ...item, data: { ...item.data, generation } }
      : item) }));
    if (isDatabaseId(rfId)) {
      const { boardPublicId } = get();
      void writeNodeGeneration(boardPublicId, rfId, generation);
    }
  },
  updateNodeData: (rfId, partial) => {
    const existing = get().nodes.find((node) => node.id === rfId);
    set((s) => {
      const nodes = s.nodes.map((n) => n.id === rfId
        ? { ...n, data: { ...n.data, ...partial } }
        : n);
      return { nodes };
    });
    if (existing?.data.status === "idle" && isDatabaseId(rfId)) {
      void patchNode(Number(rfId), { data: partial }).catch((err) => {
        set({ error: err instanceof Error ? err.message : "Could not save node draft" });
      });
    }
  },
  updateEdgeData: (edgeId, partial) => {
    set((s) => {
      const edges = s.edges.map((e) => e.id === edgeId
        ? { ...e, data: { ...(e.data ?? {}), ...partial } }
        : e);
      return { edges };
    });
    const sourceVariantIdx = partial.sourceVariantIdx;
    if (/^\d+$/.test(edgeId) && (typeof sourceVariantIdx === "number" || sourceVariantIdx === null)) {
      void patchEdge(Number(edgeId), { source_variant_idx: sourceVariantIdx }).catch((err) => {
        set({ error: err instanceof Error ? err.message : "Could not save edge draft" });
      });
    }
  },
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  clearError: () => set({ error: null }),
}));
