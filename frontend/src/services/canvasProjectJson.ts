import { api } from '../api/client';
import type { Board } from '../store/boardApi';

type ExportNode = { id: string; type: string; x: number; y: number; data: Record<string, unknown> };

type ExportModel = { family?: string; id?: string; quality?: string };

function exportAspect(value: unknown, type: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.endsWith('_LANDSCAPE') || value === '16:9') return type === 'video' ? 'VIDEO_ASPECT_RATIO_LANDSCAPE' : 'IMAGE_ASPECT_RATIO_LANDSCAPE';
  if (value.endsWith('_PORTRAIT') || value === '9:16') return type === 'video' ? 'VIDEO_ASPECT_RATIO_PORTRAIT' : 'IMAGE_ASPECT_RATIO_PORTRAIT';
  if (value.endsWith('_SQUARE') || value === '1:1') return 'IMAGE_ASPECT_RATIO_SQUARE';
  return value;
}

export async function exportCanvasProjectJson(project: Board): Promise<number> {
  const detail = await api<{
    board: Board;
    nodes: ExportNode[];
    edges: Array<{ source_id: number; target_id: number; source_variant_idx?: number | null }>;
  }>(`/api/boards/${project.id}`);
  const nodes = detail.nodes
    .map((node) => ({ ...node, id: String(node.id) }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const objectIdByNodeId = new Map(nodes.map((node, index) => [node.id, `node-${String(index + 1).padStart(3, '0')}`]));
  const sourceObjectByMediaId = new Map<string, string>();
  const sourceTypeByMediaId = new Map<string, string>();
  const sourceVariantByMediaId = new Map<string, number | null>();
  for (const node of nodes) {
    const objectId = objectIdByNodeId.get(node.id)!;
    const variants = Array.isArray(node.data.mediaIds) ? node.data.mediaIds : [];
    variants.forEach((mediaId, index) => {
      if (typeof mediaId !== 'string' || !mediaId) return;
      sourceObjectByMediaId.set(mediaId, objectId);
      sourceTypeByMediaId.set(mediaId, node.type);
      sourceVariantByMediaId.set(mediaId, index);
    });
    if (typeof node.data.mediaId === 'string' && node.data.mediaId) {
      sourceObjectByMediaId.set(node.data.mediaId, objectId);
      sourceTypeByMediaId.set(node.data.mediaId, node.type);
      const index = variants.indexOf(node.data.mediaId);
      sourceVariantByMediaId.set(node.data.mediaId, index >= 0 ? index : null);
    }
  }

  const extraEdges: Array<{ source: string; target: string; relation: string; source_variant_idx: number | null; media_type: string }> = [];
  const unresolved: Array<{ node: string; count: number }> = [];
  const exportedNodes = nodes.map((node) => {
    const id = objectIdByNodeId.get(node.id)!;
    const config = node.data.generation && typeof node.data.generation === 'object'
      ? node.data.generation as Record<string, unknown>
      : {};
    const model = config.model && typeof config.model === 'object' ? config.model as ExportModel : null;
    const omni = model?.family === 'omni_flash' || Boolean(model?.id?.startsWith('abra_'));
    const isGenerativeNode = ["image", "character", "video", "Storyboard"].includes(node.type);
    const generation: Record<string, unknown> = {
      backend: config.backend ?? null,
      aspect_ratio: exportAspect(config.aspectRatio, node.type),
      model,
      resolution: omni ? config.resolution ?? null : null,
      duration_s: omni ? config.duration ?? null : null,
      ...(node.type === 'video' ? { camera: config.camera ?? null } : {}),
      ...(typeof config.operation === 'string' ? { operation: config.operation } : {}),
      ...(typeof config.videoMode === 'string' ? { video_mode: config.videoMode } : {}),
      ...(Array.isArray(config.prompts) ? { prompts: config.prompts } : {}),
      ...(node.type === 'Storyboard' && config.storyboardGrid ? { storyboard_grid: config.storyboardGrid } : {}),
      ...(Array.isArray(config.selectedSourceIdx) ? { selected_source_idx: config.selectedSourceIdx } : {}),
    };
    const references = new Set<string>();
    const addReference = (mediaId: unknown, assumeVideo: boolean) => {
      if (typeof mediaId !== 'string' || !mediaId || references.has(mediaId)) return;
      references.add(mediaId);
      const source = sourceObjectByMediaId.get(mediaId);
      if (!source) return;
      const sourceType = sourceTypeByMediaId.get(mediaId);
      const sourceIsVideo = sourceType ? sourceType === 'video' : assumeVideo;
      extraEdges.push({
        source,
        target: id,
        relation: 'generation_input',
        source_variant_idx: sourceVariantByMediaId.get(mediaId) ?? null,
        media_type: sourceIsVideo ? 'video' : 'image',
      });
    };
    for (const mediaId of (Array.isArray(config.independentVideoMediaIds) ? config.independentVideoMediaIds : [])) addReference(mediaId, true);
    for (const mediaId of (Array.isArray(config.r2vAdditionalMediaIds) ? config.r2vAdditionalMediaIds : [])) addReference(mediaId, false);
    addReference(config.t2vLibraryMediaId, false);
    const unresolvedCount = [...references].filter((mediaId) => !sourceObjectByMediaId.has(mediaId)).length;
    if (unresolvedCount) unresolved.push({ node: id, count: unresolvedCount });
    const properties = Object.fromEntries(['charCountry', 'charVibe', 'charGender', 'charExtras']
      .filter((key) => config[key] !== null && config[key] !== undefined && config[key] !== '')
      .map((key) => [key, config[key]]));
    return {
      id,
      type: node.type,
      ...(typeof config.prompt === 'string' && config.prompt ? { prompt: config.prompt } : {}),
      ...(isGenerativeNode ? { generation } : {}),
      ...(Object.keys(properties).length ? { properties } : {}),
    };
  });

  const canvasEdges = detail.edges.flatMap((edge) => {
    const source = objectIdByNodeId.get(String(edge.source_id));
    const target = objectIdByNodeId.get(String(edge.target_id));
    return source && target ? [{ source, target, relation: 'canvas', source_variant_idx: edge.source_variant_idx ?? null }] : [];
  });
  const allEdges = [...canvasEdges, ...extraEdges];
  const seen = new Set<string>();
  const edges = allEdges.filter((edge) => {
    const key = `${edge.source}|${edge.target}|${edge.relation}|${edge.source_variant_idx ?? ''}|${'media_type' in edge ? edge.media_type : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const payload = {
    format: 'flow-hub-canvas-project',
    format_version: 3,
    project: { name: detail.board.name },
    nodes: exportedNodes,
    edges,
    ...(unresolved.length ? { unresolved_media_references: unresolved } : {}),
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${detail.board.name.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'canvas-project'}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return unresolved.length;
}
