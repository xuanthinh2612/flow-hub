import type { Edge } from "@xyflow/react";
import type { FlowNode } from "../../store/board";
import { IMAGE_ASPECT_RATIOS, type AspectKey, type ImageAspectKey, type VideoAspectKey } from "../constants.ts";

export function imageAspectToVideo(img: string | undefined): VideoAspectKey | null {
  if (img === "IMAGE_ASPECT_RATIO_LANDSCAPE") return "VIDEO_ASPECT_RATIO_LANDSCAPE";
  if (img === "IMAGE_ASPECT_RATIO_PORTRAIT") return "VIDEO_ASPECT_RATIO_PORTRAIT";
  if (img === "IMAGE_ASPECT_RATIO_SQUARE") return "VIDEO_ASPECT_RATIO_PORTRAIT";
  return null;
}

// Walk upstream of the target node, collect each upstream's aspectRatio,
// then apply the user's rule:
//   • single distinct aspect → match it
//   • multiple distinct aspects → fall back to 9:16
//   • zero upstream / unknown → caller's default
export function pickDefaultAspect(
  rfId: string,
  targetType: string,
  nodes: FlowNode[],
  edges: Edge[],
): AspectKey | null {
  const upstreamAspects: string[] = [];
  for (const e of edges) {
    if (e.target !== rfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    const ar = src.data.aspectRatio;
    if (typeof ar === "string" && ar.length > 0) upstreamAspects.push(ar);
  }
  if (upstreamAspects.length === 0) return null;

  if (targetType === "video") {
    const mapped = upstreamAspects
      .map(imageAspectToVideo)
      .filter((x): x is VideoAspectKey => x !== null);
    if (mapped.length === 0) return null;
    const unique = new Set(mapped);
    if (unique.size === 1) return mapped[0];
    return "VIDEO_ASPECT_RATIO_PORTRAIT";
  }
  // Image (and character — though character has its own opinionated
  // default; the caller short-circuits before reaching here).
  const validImg = upstreamAspects.filter((a): a is ImageAspectKey =>
    IMAGE_ASPECT_RATIOS.some((p) => p.key === a),
  );
  if (validImg.length === 0) return null;
  const unique = new Set(validImg);
  if (unique.size === 1) return validImg[0];
  return "IMAGE_ASPECT_RATIO_PORTRAIT";
}

