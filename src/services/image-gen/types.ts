// CarkedIt API — image generation common types
//
// A lightweight abstraction over AI image-generation services so the admin
// test page can switch providers without the client knowing implementation
// details. Add a new provider by dropping a file into ./providers/ and
// registering it in ./index.ts.

export type StyleJson = Record<string, string>;

/** Callback fired by providers during polling to relay progress to the caller. */
export type ProgressCallback = (info: {
  /** Upstream API status string (e.g. "Pending", "Processing", "COMPLETE"). */
  status: string;
  /** Milliseconds since the generation request was submitted. */
  elapsed: number;
}) => void;

export interface GenerateRequest {
  /**
   * Final prompt sent upstream. Caller assembles this via buildPrompt()
   * (or passes a user-edited override).
   */
  prompt: string;
  /**
   * Raw style JSON — kept on the request for providers that want to do
   * structured prompting instead of a flat string.
   */
  style?: StyleJson;
  options?: {
    width?: number;
    height?: number;
  };
  /** Optional progress callback — called on every poll tick during generation. */
  onProgress?: ProgressCallback;
}

export interface GenerateResponse {
  /** Provider-hosted URL of the finished image. */
  imageUrl: string;
  /** Stable provider slug (matches ImageGenProvider.id). */
  provider: string;
  /** Exact prompt string sent to the upstream API. */
  promptSent: string;
  /** Free-form provider-specific metadata (job id, seed, etc). */
  meta?: Record<string, any>;
  /** Tokens/credits consumed by this generation (null if provider doesn't report). */
  tokensUsed?: number | null;
  /** Estimated cost in USD for this single generation. */
  costUsd?: number | null;
}

export interface ProviderPricing {
  /** Cost in USD per megapixel of output image. */
  costPerMegapixel: number;
  /** Provider-specific token/credit count per image (null if N/A). */
  tokensPerImage: number | null;
  /** URL to the provider's pricing page. */
  pricingUrl: string;
}

export interface ImageGenProvider {
  /** Stable slug — used in API bodies and the client dropdown. */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Known pricing for this provider tier. */
  pricing: ProviderPricing;
  /**
   * Returns true when the provider has everything it needs to run
   * (typically: API key env var present).
   */
  isConfigured(): boolean;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

export interface ProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  pricing: ProviderPricing;
}
