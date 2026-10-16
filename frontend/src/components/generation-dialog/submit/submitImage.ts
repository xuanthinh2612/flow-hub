import type { DispatchOpts } from "./submitVideo.ts";

export function submitImage(ctx: {
  rfId: string;
  finalPrompt: string;
  perVariantPrompts?: string[];
  aspectRatio: string;
  variants: number;
  dispatchGeneration: (rfId: string, opts: DispatchOpts) => Promise<void>;
  closeGenerationDialog: () => void;
}): void {
  const { rfId, finalPrompt, perVariantPrompts, aspectRatio, variants, dispatchGeneration, closeGenerationDialog } = ctx;
  dispatchGeneration(rfId, {
    prompt: finalPrompt,
    aspectRatio,
    variantCount: variants,
    prompts: perVariantPrompts,
  });
  closeGenerationDialog();
}
