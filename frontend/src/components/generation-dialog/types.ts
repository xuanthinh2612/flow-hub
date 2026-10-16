import type { FlowNode, StoryboardGrid } from "../../store/board";
import type { MediaItem } from "../../api/types";
import type { ImageModelKey, MediaProviderKey, OmniFlashDuration, OmniFlashResolution, VideoModelFamily, VideoQuality } from "../../store/settings";
import type { CountryKey, GenderKey, VibeKey } from "../../constants/character";

export type RefSourceEntry = {
  edgeId: string;
  node: FlowNode;
  // `undefined` = upstream node hasn't produced any media yet. Kept in the
  // list (rather than dropped) so it can surface as a pending notice.
  mediaId: string | undefined;
  variantIdx: number | null;
  allVariants: string[];
};

export type GenerationFormState = {
  prompt: string;
  aspectRatio: string;
  variants: number;
  camera: CameraKey;
  storyboardGrid: StoryboardGrid;
  charGender: GenderKey | null;
  charCountry: CountryKey | null;
  charVibe: VibeKey;
  charExtras: string;
  selectedSourceIdx: number[] | null;
  t2vLibraryMediaId: string | null;
  t2vLibraryMediaItem: MediaItem | null;
  independentVideoMediaIds: string[];
  independentVideoMode: "i2v" | "r2v";
  connectedVideoMode: "i2v" | "r2v";
  /** Only relevant when upstream is a single Veo video node (video_continuation context).
   *  "continuation" = extract last frame (existing behaviour).
   *  "extend" = call fZytfe Veo Extension Lite. */
  videoExtendMode: "continuation" | "extend";
  r2vAdditionalMediaIds: string[];
  omniVideoMode?: "default" | "video_reference";
  videoReferenceMediaId?: string | null;
  backend: MediaProviderKey;
  imageModel: ImageModelKey;
  videoModel: VideoModelFamily;
  videoQuality: VideoQuality;
  omniFlashDuration: OmniFlashDuration;
  omniFlashResolution: OmniFlashResolution;
};

export type FormAction = Partial<GenerationFormState>;

export function reducer(
  state: GenerationFormState,
  patch: FormAction,
): GenerationFormState {
  return { ...state, ...patch };
}

