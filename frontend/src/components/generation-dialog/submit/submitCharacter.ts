import { buildCharacterPrompt } from "../lib/characterPrompt.ts";
import { useBoardStore } from "../../../store/board.ts";
import type { AspectKey } from "../constants.ts";
import type { CountryKey, GenderKey, VibeKey } from "../../../constants/character.ts";
import type { DispatchOpts } from "./submitVideo.ts";

export function submitCharacter(ctx: {
  rfId: string;
  prompt: string;
  charGender: GenderKey | null;
  charCountry: CountryKey | null;
  charVibe: VibeKey;
  charExtras: string;
  aspectRatio: AspectKey | string;
  variants: number;
  dispatchGeneration: (rfId: string, opts: DispatchOpts) => Promise<void>;
  closeGenerationDialog: () => void;
}): void {
  const { rfId, prompt, charGender, charCountry, charVibe, charExtras, aspectRatio, variants, dispatchGeneration, closeGenerationDialog } = ctx;
  const built = buildCharacterPrompt(charGender, charCountry, charVibe, charExtras);
  const finalPrompt = prompt.trim() || built;
  useBoardStore.getState().updateNodeGeneration(rfId, {
    prompt: finalPrompt, charCountry, charVibe, charGender, charExtras,
  });
  dispatchGeneration(rfId, { prompt: finalPrompt, aspectRatio, variantCount: variants });
  closeGenerationDialog();
}
