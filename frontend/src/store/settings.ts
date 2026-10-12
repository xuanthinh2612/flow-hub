import { create } from "zustand";

/**
 * Per-user model preferences. Survives page reload via localStorage —
 * single-user, single-host app, so no need for server persistence.
 *
 * Image model: Flow ships two checkpoints — "NANO_BANANA_PRO" (premium,
 * higher quality, slower) and "NANO_BANANA_2" (faster, lighter). Users
 * pick once in the dashboard Settings panel; every gen_image / edit_image
 * dispatch reads the cached preference and forwards it to the worker.
 *
 * Video model is currently derived from paygate tier + aspect (resolved
 * server-side via VIDEO_MODEL_KEYS), so it's a *display* on the panel
 * rather than a switchable preference. When/if Flow ships variants per
 * tier (e.g. fast vs quality) we extend this store with `videoModelKey`.
 */
export type ImageModelKey = "NANO_BANANA_PRO" | "NANO_BANANA_2";
// Veo 3.1 ships in four flavours:
//   - Lite (smaller checkpoint, fastest, lower fidelity)
//   - Fast (default — bigger model, balanced)
//   - Quality (highest fidelity, slowest)
//   - Lite Relaxed (Lite on a low-priority queue, 0 credits — Ultra only)
// Choice applies globally across both portrait and landscape; backend
// resolves the actual model key at dispatch time from [tier][quality][aspect].
// Tier 1 (Pro) users picking `lite_relaxed` fall back to Fast on the
// backend (and the Settings UI locks that radio for them).
export type VideoQuality =
  | "fast"
  | "lite"
  | "quality"
  | "lite_relaxed";

// Video model family. "veo" = the existing Veo 3.1 i2v family controlled
// by videoQuality (lite/fast/quality/...). "omni_flash" = the new
// reference-image r2v model with per-duration credit cost and no
// per-tier quality variants — duration is picked per dispatch in the
// GenerationDialog. The video dispatch path branches on this.
export type VideoModelFamily = "veo" | "omni_flash";

// Omni Flash duration → credit cost (informational, surfaced in the
// dialog so the user sees the cost before submit). Mirrors the backend
// OMNI_FLASH_CREDIT_COST table — pin both via tests.
export const OMNI_FLASH_CREDIT_COST: Record<4 | 6 | 8 | 10, number> = {
  4: 15,
  6: 20,
  8: 25,
  10: 30,
};
export type OmniFlashDuration = 4 | 6 | 8 | 10;
export const OMNI_FLASH_DURATIONS: OmniFlashDuration[] = [4, 6, 8, 10];
export type OmniFlashResolution = "360p" | "720p";
export const OMNI_FLASH_RESOLUTIONS: OmniFlashResolution[] = ["360p", "720p"];

// Generation backend. "flow" = the existing Chrome-extension → Google
// Flow path. "muse" = delegated to a Pax worker via the provider-job
// queue (no Flow plan, no extension needed). Picked per dispatch in the
// GenerationDialog and sticky — persisted here like the model picks.
export type MediaProviderKey = "flow" | "muse";

interface SettingsState {
  imageModel: ImageModelKey;
  videoQuality: VideoQuality;
  videoModel: VideoModelFamily;
  omniFlashDuration: OmniFlashDuration;
  omniFlashResolution: OmniFlashResolution;
  mediaProvider: MediaProviderKey;
  setImageModel(model: ImageModelKey): void;
  setVideoQuality(q: VideoQuality): void;
  setVideoModel(m: VideoModelFamily): void;
  setOmniFlashDuration(d: OmniFlashDuration): void;
  setOmniFlashResolution(r: OmniFlashResolution): void;
  setMediaProvider(p: MediaProviderKey): void;
}

const STORAGE_KEY = "flowboard.settings.v1";

interface PersistShape {
  imageModel?: ImageModelKey;
  videoQuality?: VideoQuality;
  videoModel?: VideoModelFamily;
  omniFlashDuration?: OmniFlashDuration;
  omniFlashResolution?: OmniFlashResolution;
  mediaProvider?: MediaProviderKey;
}

function loadPersisted(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function persist(state: PersistShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled / quota — non-fatal, just lose persistence.
  }
}

const persisted = loadPersisted();

const VALID_VIDEO_QUALITIES: VideoQuality[] = ["fast", "lite", "quality", "lite_relaxed"];
const VALID_MEDIA_PROVIDERS: MediaProviderKey[] = ["flow", "muse"];
const VALID_OMNI_DURATIONS = [4, 6, 8, 10];

function snapshotPersist(get: () => SettingsState): PersistShape {
  return {
    imageModel: get().imageModel,
    videoQuality: get().videoQuality,
    videoModel: get().videoModel,
    omniFlashDuration: get().omniFlashDuration,
    omniFlashResolution: get().omniFlashResolution,
    mediaProvider: get().mediaProvider,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  imageModel: persisted.imageModel ?? "NANO_BANANA_2",
  videoQuality:
    persisted.videoQuality && VALID_VIDEO_QUALITIES.includes(persisted.videoQuality)
      ? persisted.videoQuality
      : "fast",
  videoModel: persisted.videoModel ?? "veo",
  omniFlashDuration: 
    typeof persisted.omniFlashDuration === "number" && VALID_OMNI_DURATIONS.includes(persisted.omniFlashDuration)
      ? persisted.omniFlashDuration
      : (typeof persisted.omniFlashDuration === "string" && VALID_OMNI_DURATIONS.includes(parseInt(persisted.omniFlashDuration, 10)))
        ? parseInt(persisted.omniFlashDuration, 10) as OmniFlashDuration
        : 4,
  omniFlashResolution:
    persisted.omniFlashResolution && OMNI_FLASH_RESOLUTIONS.includes(persisted.omniFlashResolution)
      ? persisted.omniFlashResolution
      : "720p",
  mediaProvider:
    persisted.mediaProvider && VALID_MEDIA_PROVIDERS.includes(persisted.mediaProvider)
      ? persisted.mediaProvider
      : "flow",
  setImageModel(model) {
    set({ imageModel: model });
    persist(snapshotPersist(get));
  },
  setVideoQuality(q) {
    set({ videoQuality: q });
    persist(snapshotPersist(get));
  },
  setVideoModel(m) {
    set({ videoModel: m });
    persist(snapshotPersist(get));
  },
  setOmniFlashDuration(d) {
    set({ omniFlashDuration: d });
    persist(snapshotPersist(get));
  },
  setOmniFlashResolution(r) {
    set({ omniFlashResolution: r });
    persist(snapshotPersist(get));
  },
  setMediaProvider(p) {
    set({ mediaProvider: p });
    persist(snapshotPersist(get));
  },
}));
