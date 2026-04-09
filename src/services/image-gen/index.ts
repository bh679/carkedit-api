// CarkedIt API — image-generation provider registry.
//
// Drop a new provider into ./providers/ and register it here. The admin
// page reads listProviders() to populate its dropdown and calls getProvider(id)
// on every generate request.

import type { ImageGenProvider, ProviderInfo } from "./types.js";
import { leonardoPhoenix1 } from "./providers/leonardo.js";
import {
  flux2Pro,
  flux2Max,
  flux2Klein9b,
  flux2Klein4b,
} from "./providers/flux.js";

const providers: Record<string, ImageGenProvider> = {
  [leonardoPhoenix1.id]: leonardoPhoenix1,
  [flux2Pro.id]: flux2Pro,
  [flux2Max.id]: flux2Max,
  [flux2Klein9b.id]: flux2Klein9b,
  [flux2Klein4b.id]: flux2Klein4b,
};

export function listProviders(): ProviderInfo[] {
  return Object.values(providers).map((p) => ({
    id: p.id,
    label: p.label,
    configured: p.isConfigured(),
    pricing: p.pricing,
  }));
}

export function getProvider(id: string): ImageGenProvider | null {
  return providers[id] ?? null;
}

export { buildPrompt } from "./buildPrompt.js";
export type {
  ImageGenProvider,
  GenerateRequest,
  GenerateResponse,
  StyleJson,
  ProviderInfo,
} from "./types.js";
