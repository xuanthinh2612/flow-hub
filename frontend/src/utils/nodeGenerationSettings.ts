import { patchNode } from '../store/boardApi';

const pendingNodeGenerations = new Map<string, { timer: ReturnType<typeof setTimeout>; value: Record<string, unknown> }>();
const nodeGenerationWrites = new Map<string, Promise<unknown>>();

function flushPendingNodeGenerations(keepalive = false): void {
  for (const [key, pending] of pendingNodeGenerations) {
    clearTimeout(pending.timer);
    pendingNodeGenerations.delete(key);
    const [projectId, rawNodeId] = key.split(':');
    const nodeId = Number(rawNodeId);
    if (!projectId || !Number.isSafeInteger(nodeId)) continue;
    const previous = nodeGenerationWrites.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(() => patchNode(nodeId, { data: { generation: pending.value } }, { keepalive }));
    nodeGenerationWrites.set(key, write);
    void write.catch((err) => {
      console.warn('Could not persist node generation settings to SQLite', err);
    }).finally(() => {
      if (nodeGenerationWrites.get(key) === write) nodeGenerationWrites.delete(key);
    });
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flushPendingNodeGenerations(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingNodeGenerations(true);
  });
}

export function writeNodeGeneration(
  projectId: string | null,
  rfId: string,
  value: Record<string, unknown>,
): Promise<boolean> {
  if (!projectId || !/^\d+$/.test(rfId)) return Promise.resolve(false);
  const key = `${projectId}:${rfId}`;
  const pending = pendingNodeGenerations.get(key);
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => flushPendingNodeGenerations(), 250);
  pendingNodeGenerations.set(key, { timer, value });
  return Promise.resolve(true);
}

export function cancelPendingNodeGeneration(projectId: string | null, rfId: string): void {
  if (!projectId || !/^\d+$/.test(rfId)) return;
  const key = `${projectId}:${rfId}`;
  const pending = pendingNodeGenerations.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    pendingNodeGenerations.delete(key);
  }
}

export async function writeNodeGenerationNow(
  projectId: string | null,
  rfId: string,
  value: Record<string, unknown>,
): Promise<void> {
  if (!projectId || !/^\d+$/.test(rfId)) throw new Error("Node is not persisted in this project");
  const key = `${projectId}:${rfId}`;
  const pending = pendingNodeGenerations.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    pendingNodeGenerations.delete(key);
  }
  const previous = nodeGenerationWrites.get(key) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(() => patchNode(Number(rfId), { data: { generation: value } }));
  nodeGenerationWrites.set(key, write);
  try {
    await write;
  } finally {
    if (nodeGenerationWrites.get(key) === write) nodeGenerationWrites.delete(key);
  }
}
