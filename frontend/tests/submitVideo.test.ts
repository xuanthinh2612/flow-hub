import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVideoSubmit, type BuildVideoSubmitContext } from "../src/components/generation-dialog/submit/submitVideo.ts";
import type { RefSourceEntry } from "../src/components/generation-dialog/types.ts";
import type { VideoUpstreamInfo } from "../src/utils/videoFrame.ts";

const info = (mode: VideoUpstreamInfo["mode"], sourceMediaId?: string): VideoUpstreamInfo => ({
  mode,
  label: "source",
  sourceMediaId,
  isVideoUpstream: mode === "video_continuation",
  isImageUpstream: mode === "i2v" || mode === "r2v",
  upstreamNodes: [],
});

const base = (overrides: Partial<BuildVideoSubmitContext> = {}): BuildVideoSubmitContext => ({
  prompt: "motion",
  aspectRatio: "portrait",
  camera: "static",
  variants: 2,
  isOmniVideo: false,
  omniVideoMode: "default",
  videoReferenceMediaId: null,
  videoInfo: info("t2v"),
  r2vAdditionalMediaIds: [],
  independentVideoMediaIds: [],
  independentVideoMode: "i2v",
  hasPendingUpstream: false,
  isExtend: false,
  isEffectiveR2v: false,
  refSourceNodes: [],
  sourceMediaIds: [],
  selectedSourceIdx: new Set(),
  actualConnectedMode: "i2v",
  connectedVideoMode: "i2v",
  ...overrides,
});

test("video_reference dispatch contains the reference and additional images, and missing reference keeps exact error", () => {
  const result = buildVideoSubmit(base({
    isOmniVideo: true,
    omniVideoMode: "video_reference",
    videoReferenceMediaId: "video-ref",
    r2vAdditionalMediaIds: ["image-ref"],
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.dispatch.videoMode, "video_reference");
  assert.equal(result.dispatch.variantCount, 2);
  assert.equal(result.dispatch.sourceMediaId, "video-ref");
  assert.deepEqual(result.dispatch.sourceMediaIds, ["image-ref"]);

  assert.deepEqual(buildVideoSubmit(base({ isOmniVideo: true, omniVideoMode: "video_reference" })), {
    ok: false,
    nodeError: "Vui lòng chọn hoặc tải lên video tham chiếu.",
  });
});

test("independent t2v keeps its effective mode and source IDs", () => {
  const result = buildVideoSubmit(base({ independentVideoMediaIds: ["a", "b"] }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.dispatch.videoMode, "r2v");
  assert.equal(result.dispatch.variantCount, 2);
  assert.deepEqual(result.dispatch.sourceMediaIds, ["a", "b"]);
});

test("omni flash pure text-to-video dispatches t2v without media sources", () => {
  const result = buildVideoSubmit(base({ isOmniVideo: true, independentVideoMediaIds: [] }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.dispatch.videoMode, "t2v");
  assert.equal(result.dispatch.sourceMediaIds, undefined);
  assert.equal(result.dispatch.sourceMediaId, undefined);
});

test("continuation extend and last-frame dispatch use their original source fields and counts", () => {
  const extend = buildVideoSubmit(base({ videoInfo: info("video_continuation", "video-1"), isExtend: true }));
  assert.equal(extend.ok, true);
  if (!extend.ok) return;
  assert.equal(extend.dispatch.videoMode, "extend_video");
  assert.equal(extend.dispatch.sourceMediaId, "video-1");
  assert.equal(extend.dispatch.variantCount, 2);
  assert.deepEqual(extend.patchNodeData, { extractingFrame: false, extractError: null });

  const lastFrame = buildVideoSubmit(base({ videoInfo: info("video_continuation", "video-1") }));
  assert.equal(lastFrame.ok, true);
  if (!lastFrame.ok) return;
  assert.equal(lastFrame.dispatch.videoMode, "i2v");
  assert.equal(lastFrame.dispatch.sourceVideoId, "video-1");
  assert.equal(lastFrame.dispatch.variantCount, 1);

  assert.deepEqual(buildVideoSubmit(base({ videoInfo: info("video_continuation"), isExtend: true })), {
    ok: false,
    nodeError: "Video trước chưa có file để kéo dài.",
  });
});

test("r2v keeps image/video source arrays and variants", () => {
  const imageRef = { edgeId: "e1", mediaId: "image-1", variantIdx: null, allVariants: [], node: { data: { type: "image" } } } as RefSourceEntry;
  const videoRef = { edgeId: "e2", mediaId: "video-1", variantIdx: null, allVariants: [], node: { data: { type: "video" } } } as RefSourceEntry;
  const result = buildVideoSubmit(base({ videoInfo: info("r2v"), isEffectiveR2v: true, refSourceNodes: [imageRef, videoRef], r2vAdditionalMediaIds: ["image-2"] }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.dispatch.videoMode, "r2v");
  assert.equal(result.dispatch.variantCount, 2);
  assert.deepEqual(result.dispatch.sourceMediaIds, ["image-1", "image-2"]);
  assert.deepEqual(result.dispatch.sourceVideoIds, ["video-1"]);
});

test("i2v uses sourceMediaId for one source and sourceMediaIds with multiplied variants for many", () => {
  const single = buildVideoSubmit(base({ videoInfo: info("i2v"), sourceMediaIds: ["image-1"], selectedSourceIdx: new Set([0]) }));
  assert.equal(single.ok, true);
  if (!single.ok) return;
  assert.equal(single.dispatch.videoMode, "i2v");
  assert.equal(single.dispatch.sourceMediaId, "image-1");
  assert.equal(single.dispatch.sourceMediaIds, undefined);
  assert.equal(single.dispatch.variantCount, 2);

  const multi = buildVideoSubmit(base({
    videoInfo: info("i2v"),
    sourceMediaIds: ["image-1", "image-2"],
    selectedSourceIdx: new Set([0, 1]),
  }));
  assert.equal(multi.ok, true);
  if (!multi.ok) return;
  assert.equal(multi.dispatch.videoMode, "i2v");
  assert.equal(multi.dispatch.sourceMediaId, undefined);
  assert.deepEqual(multi.dispatch.sourceMediaIds, ["image-1", "image-2"]);
  assert.equal(multi.dispatch.variantCount, 4);
});

test("video_reference on connected node dispatches upstream video as sourceMediaId and upstream images plus additional images as sourceMediaIds", () => {
  const imageRef = { edgeId: "e1", mediaId: "image-1", variantIdx: null, allVariants: [], node: { data: { type: "image" } } } as RefSourceEntry;
  const result = buildVideoSubmit(base({
    isOmniVideo: true,
    omniVideoMode: "video_reference",
    videoInfo: info("r2v", "video-upstream-1"),
    refSourceNodes: [imageRef],
    r2vAdditionalMediaIds: ["extra-image-2"],
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.dispatch.videoMode, "video_reference");
  assert.equal(result.dispatch.sourceMediaId, "video-upstream-1");
  assert.deepEqual(result.dispatch.sourceMediaIds, ["image-1", "extra-image-2"]);
});
