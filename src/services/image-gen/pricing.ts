// CarkedIt API — image generation provider pricing.
//
// Single source of truth for all provider costs. Rates are sourced
// from the official pricing pages:
//   - BFL FLUX:    https://bfl.ai/pricing  (per megapixel)
//   - Leonardo:    https://leonardo.ai/pricing  (flat per image)
//
// BFL uses megapixel-based pricing — cost = costPerMegapixel * (w*h / 1e6).
// Leonardo uses flat token pricing — costPerMegapixel is the flat cost
// at the default 1MP resolution.

import type { ProviderPricing } from "./types.js";

export const PROVIDER_PRICING: Record<string, ProviderPricing> = {
  "flux-2-pro": {
    costPerMegapixel: 0.030,
    tokensPerImage: 1,
    pricingUrl: "https://bfl.ai/pricing",
  },
  "flux-2-max": {
    costPerMegapixel: 0.070,
    tokensPerImage: 1,
    pricingUrl: "https://bfl.ai/pricing",
  },
  "flux-2-klein-9b": {
    costPerMegapixel: 0.015,
    tokensPerImage: 1,
    pricingUrl: "https://bfl.ai/pricing",
  },
  "flux-2-klein-4b": {
    costPerMegapixel: 0.014,
    tokensPerImage: 1,
    pricingUrl: "https://bfl.ai/pricing",
  },
  "leonardo-phoenix-1.0": {
    costPerMegapixel: 0.020,
    tokensPerImage: 24,
    pricingUrl: "https://leonardo.ai/pricing",
  },
};
