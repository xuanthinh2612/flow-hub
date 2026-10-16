import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowNode, NodeGeneration } from "../src/store/board.ts";
import { hydrateForm, serializeForm } from "../src/components/generation-dialog/lib/formState.ts";
import type { GenerationFormState } from "../src/components/generation-dialog/types.ts";

function node(
  id: string,
  type: string,
  generation: NodeGeneration = {},
  mediaIds: string[] = [],
): FlowNode {
  return {
    id,
    data: {
      type,
      title: id,
      shortId: id,
      status: "idle",
      generation,
      mediaIds,
    },
  } as FlowNode;
}

const defaults = {
  videoModel: "veo" as const,
  videoQuality: "quality" as const,
  imageModel: "NANO_BANANA_PRO" as const,
  omniFlashDuration: 8 as const,
  omniFlashResolution: "720p" as const,
  mediaProvider: "flow" as const,
};

test("hydrateForm keeps null as the default all-variants selection", () => {
  const nodes = [
    node("target", "video"),
    node("source", "image", {}, ["m1", "m2"]),
  ];
  const form = hydrateForm({
    rfId: "target",
    nodes,
    edges: [{ id: "edge", source: "source", target: "target" }],
    defaults,
    seedPrompt: "seed",
    boardPublicId: "board",
  });

  assert.equal(form.prompt, "seed");
  assert.equal(form.selectedSourceIdx, null);
});

test("hydrateForm filters saved source indices against video upstream variants", () => {
  const nodes = [
    node("target", "video", { selectedSourceIdx: [1, 8, -1, 1.5, 0] }),
    node("source", "image", {}, ["m1", "m2"]),
  ];
  const form = hydrateForm({
    rfId: "target",
    nodes,
    edges: [{ id: "edge", source: "source", target: "target" }],
    defaults,
    seedPrompt: "seed",
    boardPublicId: null,
  });

  assert.deepEqual(form.selectedSourceIdx, [1, 0]);
});

test("hydrateForm applies storyboard and character prompt defaults", () => {
  const storyboardVideo = node("video", "video");
  const storyboard = node("storyboard", "Storyboard", { storyboardGrid: "2x3" });
  const videoForm = hydrateForm({
    rfId: "video",
    nodes: [storyboardVideo, storyboard],
    edges: [{ id: "sb-edge", source: "storyboard", target: "video" }],
    defaults,
    seedPrompt: "seed",
    boardPublicId: null,
  });
  assert.match(videoForm.prompt, /frame 1.*frame 6/i);

  const characterForm = hydrateForm({
    rfId: "character",
    nodes: [node("character", "character", { charVibe: "clean" })],
    edges: [],
    defaults,
    seedPrompt: "",
    boardPublicId: null,
  });
  assert.equal(characterForm.aspectRatio, "IMAGE_ASPECT_RATIO_SQUARE");
  assert.match(characterForm.prompt, /directly faces the camera/);
});

function form(): GenerationFormState {
  return {
    prompt: "prompt",
    aspectRatio: "VIDEO_ASPECT_RATIO_LANDSCAPE",
    variants: 3,
    camera: "dynamic",
    storyboardGrid: "2x4",
    charGender: "female",
    charCountry: "JP",
    charVibe: "clean",
    charExtras: "extras",
    selectedSourceIdx: null,
    t2vLibraryMediaId: null,
    t2vLibraryMediaItem: null,
    independentVideoMediaIds: ["ingredient"],
    independentVideoMode: "r2v",
    connectedVideoMode: "i2v",
    videoExtendMode: "extend",
    r2vAdditionalMediaIds: ["extra"],
    omniVideoMode: "default",
    videoReferenceMediaId: null,
    backend: "flow",
    imageModel: "NANO_BANANA_PRO",
    videoModel: "veo",
    videoQuality: "quality",
    omniFlashDuration: 8,
    omniFlashResolution: "720p",
  };
}

test("serializeForm persists video form fields and continuation mode", () => {
  const serialized = serializeForm(form(), {
    targetType: "video",
    isVideo: true,
    isCharacter: false,
    isStoryboard: false,
    videoMode: "video_continuation",
    videoSourceNodeFamily: "veo",
    hasAnyIncomingEdge: true,
    currentGeneration: {},
  });

  assert.equal(serialized.videoMode, "extend_video");
  assert.equal(serialized.selectedSourceIdx, null);
  assert.equal(serialized.independentVideoMode, "r2v");
  assert.deepEqual(serialized.r2vAdditionalMediaIds, ["extra"]);
});

test("hydrateForm preserves saved videoQuality in continuation mode", () => {
  const videoNode = node("target", "video", {
    model: { family: "veo", quality: "quality" },
    connectedVideoMode: "i2v",
  });
  const upstreamVideo = node("source", "video", {}, ["video-m1"]);
  const formState = hydrateForm({
    rfId: "target",
    nodes: [videoNode, upstreamVideo],
    edges: [{ id: "edge", source: "source", target: "target" }],
    defaults,
    seedPrompt: "prompt",
    boardPublicId: "board",
  });

  assert.equal(formState.videoQuality, "quality");
});

test("serializeForm sets abra_t2v model ID for t2v mode and abra_r2v for r2v mode", () => {
  const t2vSerialized = serializeForm({ ...form(), videoModel: "omni_flash", omniFlashDuration: 6, omniFlashResolution: "720p" }, {
    targetType: "video",
    isVideo: true,
    isCharacter: false,
    isStoryboard: false,
    videoMode: "t2v",
    videoSourceNodeFamily: undefined,
    hasAnyIncomingEdge: false,
    currentGeneration: {},
  });
  assert.deepEqual(t2vSerialized.model, { family: "omni_flash", id: "abra_t2v_6s" });

  const r2vSerialized = serializeForm({ ...form(), videoModel: "omni_flash", omniFlashDuration: 8, omniFlashResolution: "360p" }, {
    targetType: "video",
    isVideo: true,
    isCharacter: false,
    isStoryboard: false,
    videoMode: "r2v",
    videoSourceNodeFamily: undefined,
    hasAnyIncomingEdge: true,
    currentGeneration: {},
  });
  assert.deepEqual(r2vSerialized.model, { family: "omni_flash", id: "abra_r2v_8s_360p" });
});

