// CarkedIt API — Single-player life story endpoint.
//
// POST /api/carkedit/solo/story — public (solo needs no account), so it sits
// behind its own tight per-IP limiter. Needs ANTHROPIC_API_KEY; without it the
// route answers 503 and the client shows a friendly "unavailable" message.
import { Router } from "express";
import { storyLimiter, publicBodyLimit } from "../middleware/rate-limit.js";
import {
  validateStoryInput,
  generateLifeStory,
  StoryValidationError,
  StoryUpstreamError,
} from "../services/life-story.js";

const router = Router();

router.post("/story", storyLimiter, publicBodyLimit, async (req: any, res: any) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Story generation unavailable" });

  let input;
  try {
    input = validateStoryInput(req.body);
  } catch (err) {
    if (err instanceof StoryValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }

  try {
    const story = await generateLifeStory(input, { apiKey, model: process.env.STORY_MODEL || undefined });
    return res.json({ story });
  } catch (err) {
    const status = err instanceof StoryUpstreamError ? err.status : undefined;
    console.error("[life-story] generation failed", { message: (err as Error)?.message, status });
    return res.status(502).json({ error: "Couldn't write your story right now" });
  }
});

export default router;
