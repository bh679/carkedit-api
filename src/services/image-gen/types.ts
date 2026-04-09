// CarkedIt API — image generation common types
//
// A lightweight abstraction over AI image-generation services so the admin
// test page can switch providers without the client knowing implementation
// details. Add a new provider by dropping a file into ./providers/ and
// registering it in ./index.ts.

export type StyleJson = Record<string, string>;

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
}

export interface ImageGenProvider {
  /** Stable slug — used in API bodies and the client dropdown. */
  id: string;
  /** Human-readable label for the UI. */
  label: string;
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
}
