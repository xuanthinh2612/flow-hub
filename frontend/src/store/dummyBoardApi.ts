export type NodeType = "image" | "video" | "prompt" | "character" | "visual_asset" | "Storyboard" | "note";

export interface Board {
  id: number;
  name: string;
  project_id: string;
}

export async function listBoards() { return []; }
export async function createBoard() { return { id: 1, name: "Canvas", project_id: "default" }; }
export async function getBoard() { return { id: 1, name: "Canvas", project_id: "default", nodes: [], edges: [] }; }
export async function patchBoard() { return { id: 1, name: "Canvas", project_id: "default" }; }
export async function deleteBoard() {}
export async function createNode(data: any) { return { id: Math.floor(Math.random() * 100000), ...data }; }
export async function patchNode(id: number, data: any) { return data; }
export async function deleteNode(id: number) {}
export async function createEdge(data: any) { return { id: Math.floor(Math.random() * 100000), ...data }; }
export async function deleteEdge(id: number) {}

export async function ensureBoardProject() { return 'default'; }
export async function createRequest(data: any) { return { id: 1, status: 'completed', outputs: [] }; }
export async function getRequest(id: number) { return { id: 1, status: 'completed', outputs: [] }; }
export async function listBoardRequests(id: number) { return []; }

export type PipelineRunDTO = any;
export async function runPlan(id: number) { return null; }
export async function getPipelineRun(id: number) { return null; }

export type ReferenceCreateInput = any;
export type ReferenceItem = any;
export async function createReference(data: any) { return null; }
export async function deleteReference(id: number) { return null; }
export async function listReferences() { return []; }
export async function patchReference(id: number, data: any) { return null; }