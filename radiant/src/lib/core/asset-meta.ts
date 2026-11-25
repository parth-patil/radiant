import type { NodeArt } from './types';

export interface AssetMeta {
  prompt?: string;
  instructions?: string;
  effort?: NodeArt['effort'];
  originalAsset?: string;
  model?: string;
  revisedPrompt?: string;
  createdBy?: 'user' | 'ai';
  styleSnapshot?: import('./art/styleSheet').ArtStyleSheet;
  parentAsset?: string;
  seed?: number;
  svgSeed?: number;
  styleVersion?: number;
  templateVersion?: string;
  generatedAt?: string;
  inputHash?: string;
}

/** Asset metadata shared by the native index and portable bundle import. */
export function artworkProvenance(art: Omit<NodeArt, 'assetHash'>): AssetMeta {
  return {
    createdBy: 'ai', prompt: art.prompt, model: art.model, revisedPrompt: art.revisedPrompt,
    styleSnapshot: art.styleSnapshot, styleVersion: art.styleVersion, templateVersion: art.templateVersion,
    seed: art.seed, svgSeed: art.svgSeed, generatedAt: art.generatedAt,
    inputHash: art.inputHash, parentAsset: art.parentAsset, originalAsset: art.originalAsset,
    instructions: art.instructions, effort: art.effort
  };
}
