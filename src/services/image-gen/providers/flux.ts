// CarkedIt API — FLUX (Black Forest Labs) image-generation adapter.
//
// Target model: "FLUX 2 Pro".
//
// NOTE on naming: at time of writing, BFL's public API exposes models under
// slugs like `flux-pro-1.1` and `flux-pro-1.1-ultra`. If `flux-pro-2.0` ships
// by the time this runs, set FLUX_MODEL_SLUG below. Until then, the adapter
// defaults to FLUX 1.1 Pro (the newest generally-available Pro model) so the
// page still works — the `label` stays "FLUX 2 Pro" so the UI matches the
// user's intent, and we log the actual slug used.
// TODO(flux-2): switch default to "flux-pro-2.0" once BFL ships it.
//
// API docs: https://docs.bfl.ai/quick_start/generating_images
// Flow:
//   1. POST https://api.bfl.ai/v1/{model_slug} with { prompt, width, height }
//      → returns { id, polling_url }
//   2. Poll polling_url until status === "Ready"
//      → read result.sample (signed URL to the rendered PNG)

import type {
  GenerateRequest,
  GenerateResponse,
  ImageGenProvider,
} from "../types.js";

const BFL_API_BASE = "https://api.bfl.ai/v1";

const FLUX_MODEL_SLUG =
  process.env.FLUX_MODEL_SLUG || "flux-pro-1.1";

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 90_000;

async function pollForCompletion(
  pollingUrl: string,
  apiKey: string
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
        meta: { jobId: data?.id, slug: FLUX_MODEL_SLUG },
      };
    }
    if (status === "Request Moderated" || status === "Content Moderated") {
      // BFL's content safety filter rejected the prompt or the
      // generated image. Even at safety_tolerance=6 (our current
      // request, the most permissive BFL accepts), some content
      // still gets blocked — typically anything BFL classes as
      // extreme or recognizable real people. Give the user an
      // actionable hint since the red error box shows this verbatim.
      throw new Error(
        `BFL content moderation blocked this prompt (${status}). ` +
        `The FLUX adapter already asks for safety_tolerance=6 (most permissive); ` +
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

export const flux2Pro: ImageGenProvider = {
  id: "flux-2-pro",
  label: "FLUX 2 Pro",

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
      // BFL accepts 0–6 where higher = more permissive. The default
      // 2 rejects most death-themed prompts (the whole point of this
      // game's artwork), so we ask for 6 — BFL's most-permissive
      // tier. It still enforces hard limits (CSAM, etc.); the
      // moderation error path in pollForCompletion() surfaces a
      // rephrasing hint when content is still blocked at 6.
      safety_tolerance: 6,
      output_format: "png",
    };

    const createRes = await fetch(`${BFL_API_BASE}/${FLUX_MODEL_SLUG}`, {
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

    const { imageUrl, meta } = await pollForCompletion(pollingUrl, apiKey);

    return {
      imageUrl,
      provider: "flux-2-pro",
      promptSent: req.prompt,
      meta: { ...meta, width, height },
    };
  },
};
