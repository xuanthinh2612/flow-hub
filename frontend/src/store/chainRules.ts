// ── Chain (Run All / Run from Here) graph helpers ───────────────────────────
//
// The same rules the backend enforces in flowhub/canvas_chain.py, applied to
// the local store so the buttons dispatch in an order the engine already
// accepts: upstream first, `done` never again, one job per node. The engine's
// dependency wait loop is the queue — a downstream node dispatched before its
// upstream finishes sits in `queued` and starts on its own when the upstream
// lands, so dispatching everything up front is exactly "fill the queue".
//
// This module is deliberately free of store imports: every export is a
// function of its arguments, so `frontend/tests/chainRules.test.ts` can run
// the exact rules the canvas runs under `node --test`.

/** Node types that own a media generation. `prompt` / `note` / `merge` are
 *  structure, not work — there is nothing to run on them. */
export const CHAIN_GENERABLE_TYPES = new Set(["image", "video", "visual_asset", "character", "Storyboard"]);

/** Structural shapes of the board the rules read — kept local so importing
 *  this module never drags zustand / React Flow into a Node process. */
export type ChainEdge = { source: string; target: string };
export type ChainNode = { id: string; data: { type: string; status?: string } };

/** Every node reachable from `rootRfId` by following edges downstream. */
export function chainDescendants(rootRfId: string, edges: ChainEdge[]): string[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...(adjacency.get(rootRfId) ?? [])];
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return out;
}

/** Every node `rootRfId` depends on directly or indirectly (reverse of
 *  `chainDescendants`). Used by the failed-prerequisite rule: a node whose
 *  ancestor failed is blocked even when its own direct parent is only `idle`
 *  because that parent was parked rather than executed. */
export function chainAncestors(rootRfId: string, edges: ChainEdge[]): string[] {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...(incoming.get(rootRfId) ?? [])];
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    stack.push(...(incoming.get(current) ?? []));
  }
  return out;
}

/** Kahn over the induced subgraph `scopeIds`. Nodes in a cycle keep their
 *  relative order and are appended — nothing is silently dropped. */
export function chainTopoOrder(scopeIds: string[], edges: ChainEdge[]): string[] {
  const inside = new Set(scopeIds);
  const indegree = new Map<string, number>(scopeIds.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>(scopeIds.map((id) => [id, []]));
  for (const edge of edges) {
    if (inside.has(edge.source) && inside.has(edge.target) && edge.source !== edge.target) {
      adjacency.get(edge.source)!.push(edge.target);
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    }
  }
  const ready = scopeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const ordered: string[] = [];
  while (ready.length) {
    const current = ready.shift()!;
    ordered.push(current);
    for (const next of adjacency.get(current) ?? []) {
      const left = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  const placed = new Set(ordered);
  for (const id of scopeIds) {
    if (!placed.has(id)) ordered.push(id);
  }
  return ordered;
}

/**
 * A prerequisite upstream of `rfId` holds the run: it ran and failed (`error`
 * carries both real failures and user cancellations). Checking ancestors
 * rather than only direct parents is what stops Run All from dispatching a
 * grandchild whose parent is parked at `idle` — that job would sit in the
 * engine's wait loop against an upstream that is never going to produce
 * media. Independent nodes have no ancestors and are never blocked.
 */
export function blockedByFailedUpstream(
  rfId: string,
  nodes: ChainNode[],
  edges: ChainEdge[],
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return chainAncestors(rfId, edges).some((ancestorId) => byId.get(ancestorId)?.data.status === "error");
}

/**
 * Nodes on the board that currently have a job in flight: either the board
 * already says so (`queued`/`running`), or a generation poll is still watching
 * them. The second half covers the window between a poll being attached and
 * the first status round-trip landing, and after a reload where the board
 * read its status before `resumeActiveRequests` had stamped it.
 */
export function activeNodeIds(
  nodes: { id: string; data: { status?: string } }[],
  active: Record<string, unknown>,
): string[] {
  const polled = new Set(Object.keys(active));
  const out: string[] = [];
  for (const node of nodes) {
    if (node.data.status === "queued" || node.data.status === "running" || polled.has(node.id)) {
      out.push(node.id);
    }
  }
  return out;
}
