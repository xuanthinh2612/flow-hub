import { api } from '../api/client';
import type { Board } from '../store/boardApi';

type ExportNode = { id: string; type: string; x: number; y: number; data: Record<string, unknown> };

type ExportModel = { family?: string; id?: string; quality?: string };

function exactVideoModel(model: ExportModel | null, videoMode: unknown, aspectRatio: string | null): ExportModel | null {
  if (!model) return null;
  if (model.family !== 'veo' || typeof model.quality !== 'string') return model;

  // Keep the exact model selected by the UI in the portable file. The UI
  // stores Veo as family + quality, while dispatch turns that pair into a
  // Flow model key based on mode and aspect ratio.
  const mode = videoMode === 't2v' || videoMode === 'i2v' || videoMode === 'r2v'
    ? videoMode
    : 't2v';
  const portrait = aspectRatio === 'VIDEO_ASPECT_RATIO_PORTRAIT';
  let id: string;
  if (mode === 'r2v') {
    const landscapeFastSuffix = model.quality === 'fast' && !portrait ? '_landscape' : '';
    id = `veo_3_1_r2v_${model.quality}${landscapeFastSuffix}`;
  } else {
    id = `veo_3_1_${mode === 't2v' ? 't2v' : 'i2v'}_${model.quality}`;
  }
  return { ...model, id };
}

function videoModeForNode(node: ExportNode, config: Record<string, unknown>, edges: Array<{ source_id: number; target_id: number }>, nodesById: Map<string, ExportNode>): 't2v' | 'i2v' | 'r2v' {
  if (config.videoMode === 't2v' || config.videoMode === 'i2v' || config.videoMode === 'r2v') return config.videoMode;
  const incoming = edges.filter((edge) => String(edge.target_id) === String(node.id));
  if (!incoming.length) return 't2v';
  return incoming.some((edge) => nodesById.get(String(edge.source_id))?.type === 'video') ? 'r2v' : 'i2v';
}

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
    assets: Array<{ node_id: number; variant_idx: number; name: string; mime_type: string; data_base64: string }>;
  }>(`/api/boards/${project.id}/export`);
  const nodes = detail.nodes
    .map((node) => ({ ...node, id: String(node.id) }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const objectIdByNodeId = new Map(nodes.map((node, index) => [node.id, `node-${String(index + 1).padStart(3, '0')}`]));
  const assetsByNodeId = new Map<string, Array<{ variant_idx: number; name: string; mime_type: string; data_base64: string }>>();
  for (const asset of detail.assets) {
    const nodeId = String(asset.node_id);
    const nodeAssets = assetsByNodeId.get(nodeId) ?? [];
    nodeAssets.push({ variant_idx: asset.variant_idx, name: asset.name, mime_type: asset.mime_type, data_base64: asset.data_base64 });
    assetsByNodeId.set(nodeId, nodeAssets);
  }
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

  const extraEdges: Array<{ source: string; target: string; relation: string; source_variant_idx?: number; media_type: string }> = [];
  const unresolved: Array<{ node: string; count: number }> = [];
  const exportedNodes = nodes.map((node) => {
    const id = objectIdByNodeId.get(node.id)!;
    const config = node.data.generation && typeof node.data.generation === 'object'
      ? node.data.generation as Record<string, unknown>
      : {};
    const storedModel = config.model && typeof config.model === 'object'
      ? config.model as ExportModel
      : node.type === 'video' && typeof node.data.videoQuality === 'string'
        ? { family: 'veo', quality: node.data.videoQuality }
        : ['image', 'character', 'Storyboard'].includes(node.type) && typeof node.data.imageModel === 'string'
          ? { family: 'image', id: node.data.imageModel }
          : null;
    const rawVideoMode = node.type === 'video' ? videoModeForNode(node, config, detail.edges, nodesById) : undefined;
    const model = node.type === 'video'
      ? exactVideoModel(storedModel, rawVideoMode, exportAspect(config.aspectRatio, node.type))
      : storedModel;
    const omni = model?.family === 'omni_flash' || Boolean(model?.id?.startsWith('abra_'));
    const isGenerativeNode = ["image", "character", "video", "Storyboard"].includes(node.type);
    const aspectRatio = exportAspect(config.aspectRatio, node.type)
      ?? (node.type === 'video' ? 'VIDEO_ASPECT_RATIO_LANDSCAPE'
        : node.type === 'character' ? 'IMAGE_ASPECT_RATIO_SQUARE' : 'IMAGE_ASPECT_RATIO_LANDSCAPE');
    const generation: Record<string, unknown> = {
      backend: config.backend === 'flow' || config.backend === 'muse' ? config.backend : null,
      aspect_ratio: aspectRatio,
      model,
      resolution: omni ? config.resolution ?? null : null,
      duration_s: omni ? config.duration ?? null : null,
      ...(node.type === 'video' ? { camera: config.camera === 'dynamic' ? 'dynamic' : 'static' } : {}),
      ...(typeof config.operation === 'string' ? { operation: config.operation } : {}),
      ...(node.type === 'video' ? { video_mode: rawVideoMode } : {}),
      ...(Array.isArray(config.prompts) ? { prompts: config.prompts } : {}),
      ...(node.type === 'Storyboard' && config.storyboardGrid ? { storyboard_grid: config.storyboardGrid } : {}),
      ...(node.type === 'video' && Array.isArray(config.selectedSourceIdx)
        && config.selectedSourceIdx.some((idx) => Number.isInteger(idx) && idx >= 0)
        ? { selected_source_idx: config.selectedSourceIdx.filter((idx) => Number.isInteger(idx) && idx >= 0) }
        : {}),
    };
    const references = new Set<string>();
    const addReference = (mediaId: unknown, assumeVideo: boolean) => {
      if (typeof mediaId !== 'string' || !mediaId || references.has(mediaId)) return;
      references.add(mediaId);
      const source = sourceObjectByMediaId.get(mediaId);
      if (!source) return;
      const sourceType = sourceTypeByMediaId.get(mediaId);
      const sourceIsVideo = sourceType ? sourceType === 'video' : assumeVideo;
      const sourceVariantIdx = sourceVariantByMediaId.get(mediaId);
      extraEdges.push({
        source,
        target: id,
        relation: 'generation_input',
        ...(typeof sourceVariantIdx === 'number'
          ? { source_variant_idx: sourceVariantIdx }
          : {}),
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
      ...(typeof config.prompt === 'string' && config.prompt
        ? { prompt: config.prompt }
        : typeof node.data.prompt === 'string' && node.data.prompt ? { prompt: node.data.prompt } : {}),
      ...(isGenerativeNode ? { generation } : {}),
      ...(assetsByNodeId.has(node.id) ? { assets: assetsByNodeId.get(node.id) } : {}),
      ...(Object.keys(properties).length ? { properties } : {}),
    };
  });

  const nodesWithoutModel = exportedNodes.filter((node) =>
    ["image", "character", "video", "Storyboard"].includes(node.type)
      && (() => {
        const model = (node.generation as Record<string, unknown> | undefined)?.model as ExportModel | undefined;
        return !model || !['image', 'veo', 'omni_flash'].includes(String(model.family)) || !model.id;
      })(),
  );
  if (nodesWithoutModel.length) {
    throw new Error(`Không thể export vì thiếu model đã lưu ở node: ${nodesWithoutModel.map((node) => node.id).join(', ')}`);
  }
  const invalidBackend = exportedNodes.filter((node) =>
    ["image", "character", "video", "Storyboard"].includes(node.type)
      && !['flow', 'muse'].includes(String((node.generation as Record<string, unknown>).backend)),
  );
  if (invalidBackend.length) {
    throw new Error(`Không thể export vì thiếu backend đã lưu ở node: ${invalidBackend.map((node) => node.id).join(', ')}`);
  }
  const invalidOmniSettings = exportedNodes.filter((node) => {
    if (node.type !== 'video') return false;
    const generation = node.generation as Record<string, unknown>;
    const model = generation.model as ExportModel;
    return model.family === 'omni_flash' && (generation.resolution == null || generation.duration_s == null);
  });
  if (invalidOmniSettings.length) {
    throw new Error(`Không thể export vì thiếu resolution/duration Omni Flash ở node: ${invalidOmniSettings.map((node) => node.id).join(', ')}`);
  }

  const canvasEdges = detail.edges.flatMap((edge) => {
    const source = objectIdByNodeId.get(String(edge.source_id));
    const target = objectIdByNodeId.get(String(edge.target_id));
    return source && target
      ? [{
          source,
          target,
          relation: 'canvas',
          ...(typeof edge.source_variant_idx === 'number' && edge.source_variant_idx >= 0
            ? { source_variant_idx: edge.source_variant_idx }
            : {}),
        }]
      : [];
  });
  const allEdges = [...canvasEdges, ...extraEdges];
  const seen = new Set<string>();
  const edges = allEdges.filter((edge) => {
    const key = `${edge.source}|${edge.target}|${edge.relation}|${edge.source_variant_idx ?? ''}|${'media_type' in edge ? edge.media_type : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unresolved.length) {
    throw new Error(`Chưa thể export đầy đủ: ${unresolved.length} node đang tham chiếu media ngoài các node của project. Hãy thêm media đó thành node Reference trên canvas rồi export lại.`);
  }
  const payload = {
    format: 'flow-hub-canvas-project',
    format_version: 1,
    project: { name: detail.board.name },
    nodes: exportedNodes,
    edges,
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
