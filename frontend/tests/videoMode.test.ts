import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoUpstreamInfo } from "../src/utils/videoFrame.ts";
import {
  canSubmitVideo,
  computeCanGenerate,
  resolveVideoMode,
  type ResolveVideoModeInput,
  type VideoUiKey,
} from "../src/components/generation-dialog/lib/resolveVideoMode.ts";
import { VIDEO_MODE_UI } from "../src/components/generation-dialog/lib/videoModeUi.ts";

const video = (mode: VideoUpstreamInfo["mode"], family?: string): VideoUpstreamInfo => ({
  mode,
  label: "source mode",
  sourceMediaId: "source-media",
  isVideoUpstream: mode === "video_continuation",
  isImageUpstream: mode === "i2v" || mode === "r2v",
  upstreamNodes: [],
  sourceNodeFamily: family,
});

function resolve(overrides: Partial<ResolveVideoModeInput> = {}) {
  return resolveVideoMode({
    isVideo: true,
    isOmniVideo: false,
    omniVideoMode: "default",
    videoInfo: video("t2v"),
    independentVideoMediaIds: [],
    independentVideoMode: "i2v",
    videoExtendMode: "continuation",
    totalConnectedSources: 0,
    connectedVideoMode: "i2v",
    ...overrides,
  });
}

const uiCases: Array<[VideoUiKey, Partial<ResolveVideoModeInput>]> = [
  ["video_reference", { isOmniVideo: true, omniVideoMode: "video_reference" }],
  ["independent_t2v", {}],
  ["independent_i2v", { independentVideoMediaIds: ["image"] }],
  ["independent_r2v", { independentVideoMediaIds: ["a", "b"] }],
  ["continuation_extend", { videoInfo: video("video_continuation", "veo"), videoExtendMode: "extend" }],
  ["continuation_lastframe", { videoInfo: video("video_continuation", "omni_flash"), videoExtendMode: "extend" }],
  ["continuation_omni", { videoInfo: video("video_continuation"), isOmniVideo: true }],
  ["continuation_lastframe", { videoInfo: video("video_continuation") }],
  ["connected", { videoInfo: video("i2v") }],
];

for (const [expectedKey, overrides] of uiCases) {
  test(`resolveVideoMode maps ${expectedKey} UI state`, () => {
    const result = resolve(overrides);
    assert.equal(result.videoUiKey, expectedKey);
    assert.ok(VIDEO_MODE_UI[result.videoUiKey].title);
    assert.ok(VIDEO_MODE_UI[result.videoUiKey].placeholder);
  });
}

test("resolveVideoMode derives connected r2v when multiple sources are connected", () => {
  const result = resolve({
    videoInfo: video("i2v"),
    totalConnectedSources: 2,
  });
  assert.equal(result.actualConnectedMode, "r2v");
  assert.equal(result.isEffectiveR2v, true);
});

test("canSubmitVideo keeps video readiness conditions", () => {
  assert.equal(
    canSubmitVideo({
      isVideo: true,
      isOmniVideo: false,
      omniVideoMode: "default",
      videoReferenceMediaId: null,
      videoInfo: video("t2v"),
      hasPendingUpstream: false,
      extractingFrame: false,
      independentVideoMediaIds: [],
      prompt: "  ",
      isExtend: false,
      isEffectiveR2v: false,
      refSourceNodes: [],
      r2vAdditionalMediaIds: [],
      selectedSourceCount: 0,
    }),
    false,
  );
});

test("computeCanGenerate preserves character and busy gating", () => {
  assert.equal(
    computeCanGenerate({
      isCharacter: true,
      charGender: null,
      charCountry: null,
      charExtras: "extra detail",
      isVideo: false,
      isVideoReady: false,
      isWorking: false,
    }),
    true,
  );
  assert.equal(
    computeCanGenerate({
      isCharacter: false,
      charGender: null,
      charCountry: null,
      charExtras: "",
      isVideo: true,
      isVideoReady: true,
      isWorking: true,
    }),
    false,
  );
});
