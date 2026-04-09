// CarkedIt API — FLUX (Black Forest Labs) image-generation adapter.
//
// Exposes four provider entries:
//   - flux-2-pro       (FLUX.2 Pro)        — production quality
//   - flux-2-max       (FLUX.2 Max)        — highest quality / priciest
//   - flux-2-klein-9b  (FLUX.2 Klein 9B)   — small, fast, cheap
//   - flux-2-klein-4b  (FLUX.2 Klein 4B)   — smallest, fastest, cheapest
//
// All four share the same BFL v1 API shape (POST {slug} → polling_url,
// poll until status === "Ready", read result.sample), the same
// x-key auth header, and the same FLUX_API_KEY env var. The factory
// below builds an `ImageGenProvider` from a {id, label, slug} triple
// so adding another FLUX tier later is one line.
//
// API docs:       https://docs.bfl.ml/flux_2/flux2_overview
// OpenAPI spec:   https://api.bfl.ai/openapi.json
//
// BFL's `safety_tolerance` parameter accepts an integer 0–5 (higher =
// more permissive, verified via the OpenAPI spec). We ask for 5
// because this game's entire visual identity is death-themed art —
// the default 2 rejects most "died from" framings, which defeats the
// purpose of the admin test tool. 5 still enforces hard limits
// (CSAM, etc.); when BFL blocks at 5 the error handler surfaces a
// rephrasing hint.

import type {
  GenerateRequest,
  GenerateResponse,
  ImageGenProvider,
  ProviderPricing,
} from "../types.js";

const BFL_API_BASE = "https://api.bfl.ai/v1";

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 90_000;

async function pollForCompletion(
  pollingUrl: string,
  apiKey: string,
  modelSlug: string
): Promise<{ imageUrl: string; meta: Record<string, any> }> {
  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(pollingUrl, {
      headers: {
        accept: "application/json",
        "x-key": apiKey,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `FLUX poll failed (${res.status}): ${body.slice(0, 200)}`
      );
    }
    const data: any = await res.json();
    const status = data?.status;
    if (status === "Ready") {
      const url = data?.result?.sample;
      if (!url) {
        throw new Error("FLUX Ready but no result.sample URL");
      }
      return {
        imageUrl: url,
        meta: { jobId: data?.id, slug: modelSlug },
      };
    }
    if (status === "Request Moderated" || status === "Content Moderated") {
      // BFL's content safety filter rejected the prompt or the
      // generated image. Even at safety_tolerance=5 (our current
      // request, the most permissive BFL accepts), some content
      // still gets blocked — typically anything BFL classes as
      // extreme or recognizable real people. Give the user an
      // actionable hint since the red error box shows this verbatim.
      throw new Error(
        `BFL content moderation blocked this prompt (${status}). ` +
        `The FLUX adapter already asks for safety_tolerance=5 (most permissive); ` +
        `try rephrasing the card text — e.g. swap "Died from" framing for ` +
        `something more oblique, or remove specific violent imagery.`
      );
    }
    if (status === "Error" || status === "Failed") {
      throw new Error(`FLUX generation ${status}`);
    }
  }
  throw new Error(`FLUX generation timed out after ${POLL_TIMEOUT_MS}ms`);
}

/**
 * Build an ImageGenProvider for a given BFL FLUX model. All four
 * FLUX.2 tiers share the exact same create/poll flow — only the URL
 * slug and the display label differ.
 */
function createFluxProvider({
  id,
  label,
  slug,
  pricing,
}: {
  id: string;
  label: string;
  slug: string;
  pricing: ProviderPricing;
}): ImageGenProvider {
  return {
    id,
    label,
    pricing,

    isConfigured() {
      return !!process.env.FLUX_API_KEY;
    },

    async generate(req: GenerateRequest): Promise<GenerateResponse> {
      const apiKey = process.env.FLUX_API_KEY;
      if (!apiKey) {
        throw new Error("FLUX_API_KEY is not set — add it to carkedit-api/.env");
      }

      const width = req.options?.width ?? 1024;
      const height = req.options?.height ?? 1024;

      const body = {
        prompt: req.prompt,
        width,
        height,
        prompt_upsampling: false,
        safety_tolerance: 5,
        output_format: "png",
      };

      const createRes = await fetch(`${BFL_API_BASE}/${slug}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-key": apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => "");
        throw new Error(
          `FLUX create failed (${createRes.status}): ${errText.slice(0, 300)}`
        );
      }
      const createData: any = await createRes.json();
      const pollingUrl: string | undefined =
        createData?.polling_url || createData?.pollingUrl;
      if (!pollingUrl) {
        throw new Error("FLUX create returned no polling_url");
      }

      const { imageUrl, meta } = await pollForCompletion(pollingUrl, apiKey, slug);

      return {
        imageUrl,
        provider: id,
        promptSent: req.prompt,
        meta: { ...meta, width, height },
        tokensUsed: pricing.tokensPerImage,
        costUsd: pricing.baseCostUsd,
      };
    },
  };
}

export const flux2Pro = createFluxProvider({
  id: "flux-2-pro",
  label: "FLUX 2 Pro",
  slug: "flux-2-pro",
  pricing: { baseCostUsd: 0.05, tokensPerImage: null },
});

export const flux2Max = createFluxProvider({
  id: "flux-2-max",
  label: "FLUX 2 Max",
  slug: "flux-2-max",
  pricing: { baseCostUsd: 0.10, tokensPerImage: null },
});

export const flux2Klein9b = createFluxProvider({
  id: "flux-2-klein-9b",
  label: "FLUX 2 Klein 9B",
  slug: "flux-2-klein-9b",
  pricing: { baseCostUsd: 0.01, tokensPerImage: null },
});

export const flux2Klein4b = createFluxProvider({
  id: "flux-2-klein-4b",
  label: "FLUX 2 Klein 4B",
  slug: "flux-2-klein-4b",
  pricing: { baseCostUsd: 0.005, tokensPerImage: null },
});
