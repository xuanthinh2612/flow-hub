import assert from "node:assert/strict";
import { test } from "node:test";
import type { Edge } from "@xyflow/react";
import type { FlowNode } from "../src/store/board.ts";
import { pickDefaultAspect } from "../src/components/generation-dialog/lib/aspect.ts";
import { buildCharacterPrompt } from "../src/components/generation-dialog/lib/characterPrompt.ts";
import { pendingSourceMessage } from "../src/components/generation-dialog/lib/pendingSource.ts";

function node(id: string, type: string, aspectRatio?: string, status = "idle"): FlowNode {
  return { id, data: { type, shortId: id, title: id, status, aspectRatio } } as FlowNode;
}
function edge(source: string): Edge {
  return { id: `${source}-target`, source, target: "target" } as Edge;
}

test("pickDefaultAspect returns null without upstream aspects", () => {
  assert.equal(pickDefaultAspect("target", "image", [], []), null);
});
test("pickDefaultAspect matches one upstream aspect", () => {
  assert.equal(pickDefaultAspect("target", "image", [node("a", "image", "IMAGE_ASPECT_RATIO_LANDSCAPE")], [edge("a")]), "IMAGE_ASPECT_RATIO_LANDSCAPE");
});
test("pickDefaultAspect uses portrait for different upstream aspects", () => {
  assert.equal(pickDefaultAspect("target", "image", [node("a", "image", "IMAGE_ASPECT_RATIO_LANDSCAPE"), node("b", "image", "IMAGE_ASPECT_RATIO_SQUARE")], [edge("a"), edge("b")]), "IMAGE_ASPECT_RATIO_PORTRAIT");
});
test("pickDefaultAspect maps a square image to video portrait", () => {
  assert.equal(pickDefaultAspect("target", "video", [node("a", "image", "IMAGE_ASPECT_RATIO_SQUARE")], [edge("a")]), "VIDEO_ASPECT_RATIO_PORTRAIT");
});
test("buildCharacterPrompt keeps the pose anchor and omits null selections", () => {
  const prompt = buildCharacterPrompt(null, null, "clean", "  ");
  assert.match(prompt, /directly faces the camera/);
  assert.doesNotMatch(prompt, /null/);
});
test("pendingSourceMessage covers queued, done, other status, and image/video nouns", () => {
  assert.match(pendingSourceMessage(node("a", "image", undefined, "queued")), /Node #a/);
  assert.match(pendingSourceMessage(node("b", "video", undefined, "done")), /video file/);
  assert.match(pendingSourceMessage(node("c", "image")), /ảnh/);
  assert.match(pendingSourceMessage(node("d", "video")), /video/);
});
