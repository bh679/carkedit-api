// CarkedIt API — Leonardo.AI image-generation adapter (Phoenix 1.0 model).
//
// API docs: https://docs.leonardo.ai/reference/
// Flow:
//   1. POST /generations with { prompt, modelId, num_images, width, height }
//      → returns { sdGenerationJob: { generationId } }
//   2. Poll GET /generations/{id} until status === "COMPLETE"
//      → read generated_images[0].url
//
// Leonardo hosts the resulting image at a signed S3-ish URL — the admin page
// displays it directly and only triggers a server-side download when the user
// clicks "Save to Card".

import type {
  GenerateRequest,
  GenerateResponse,
  ImageGenProvider,
} from "../types.js";

const LEONARDO_API_BASE = "https://cloud.leonardo.ai/api/rest/v1";

// Leonardo Phoenix 1.0 model UUID. Sourced from Leonardo's public model list.
const PHOENIX_1_MODEL_ID = "6b645e3a-d64f-4341-a6d8-7a3690fbf042";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;

async function pollForCompletion(
  generationId: string,
  apiKey: string
): Promise<{ imageUrl: string; meta: Record<string, any> }> {
  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(
      `${LEONARDO_API_BASE}/generations/${generationId}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
        },
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Leonardo poll failed (${res.status}): ${body.slice(0, 200)}`
      );
    }
    const data: any = await res.json();
    const job = data?.generations_by_pk;
    if (!job) {
      throw new Error("Leonardo poll returned no job data");
    }
    if (job.status === "COMPLETE") {
      const imgs: any[] = job.generated_images || [];
      if (imgs.length === 0 || !imgs[0].url) {
        throw new Error("Leonardo completed but returned no image URL");
      }
      return {
        imageUrl: imgs[0].url,
        meta: {
          generationId,
          modelId: job.modelId,
          seed: imgs[0].seed,
        },
      };
    }
    if (job.status === "FAILED") {
      throw new Error("Leonardo generation failed");
    }
  }
  throw new Error(`Leonardo generation timed out after ${POLL_TIMEOUT_MS}ms`);
}

export const leonardoPhoenix1: ImageGenProvider = {
  id: "leonardo-phoenix-1.0",
  label: "Leonardo Phoenix 1.0",
  pricing: { costPerMegapixel: 0.02, tokensPerImage: 24, pricingUrl: "https://leonardo.ai/pricing" },

  isConfigured() {
    return !!process.env.LEONARDO_API_KEY;
  },

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const apiKey = process.env.LEONARDO_API_KEY;
    if (!apiKey) {
      throw new Error(
        "LEONARDO_API_KEY is not set — add it to carkedit-api/.env"
      );
    }

    const width = req.options?.width ?? 1024;
    const height = req.options?.height ?? 1024;

    const body = {
      prompt: req.prompt,
      modelId: PHOENIX_1_MODEL_ID,
      num_images: 1,
      width,
      height,
      alchemy: true,
      // Phoenix 1.0 supports contrast/styling knobs but we leave them at
      // defaults — the structured style JSON in the prompt is doing the work.
    };

    const createRes = await fetch(`${LEONARDO_API_BASE}/generations`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      throw new Error(
        `Leonardo create failed (${createRes.status}): ${errText.slice(0, 300)}`
      );
    }
    const createData: any = await createRes.json();
    const generationId = createData?.sdGenerationJob?.generationId;
    if (!generationId) {
      throw new Error("Leonardo create returned no generationId");
    }

    const { imageUrl, meta } = await pollForCompletion(generationId, apiKey);

    return {
      imageUrl,
      provider: "leonardo-phoenix-1.0",
      promptSent: req.prompt,
      meta: { ...meta, width, height },
      tokensUsed: leonardoPhoenix1.pricing.tokensPerImage,
      costUsd: leonardoPhoenix1.pricing.costPerMegapixel * ((width * height) / 1_000_000),
    };
  },
};
