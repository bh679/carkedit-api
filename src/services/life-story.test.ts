import { jest } from "@jest/globals";
import {
  validateStoryInput,
  buildStoryPrompt,
  generateLifeStory,
  StoryValidationError,
  StoryUpstreamError,
  DEFAULT_STORY_MODEL,
  STORY_MAX_TOKENS,
  LIMITS,
} from "./life-story.js";

type FetchFn = typeof fetch;

const validBody = {
  picks: {
    live: { title: "Ran a pub", description: "Every arvo", answer: "" },
    die: { title: "Hit by a falling coconut", description: "", answer: "In Bali" },
    bye: { title: "Became a ghost", description: "Haunts the pokies" },
  },
  eulogy: "  Gone too soon.  ",
};

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("validateStoryInput", () => {
  it("trims and normalises a valid body", () => {
    const input = validateStoryInput(validBody);
    expect(input.eulogy).toBe("Gone too soon.");
    expect(input.picks.bye).toEqual({ title: "Became a ghost", description: "Haunts the pokies", answer: "" });
  });

  it("keeps a valid would-rather card and omits it when absent", () => {
    const input = validateStoryInput({
      ...validBody,
      picks: { ...validBody.picks, die: { ...validBody.picks.die, rather: { title: " In my sleep ", answer: "Snoring" } } },
    });
    expect(input.picks.die.rather).toEqual({ title: "In my sleep", description: "", answer: "Snoring" });
    expect(input.picks.live).not.toHaveProperty("rather");
  });

  it("allows an empty eulogy", () => {
    expect(validateStoryInput({ ...validBody, eulogy: undefined }).eulogy).toBe("");
  });

  it.each([
    [null],
    [{}],
    [{ picks: { live: validBody.picks.live, die: validBody.picks.die } }],
    [{ picks: { ...validBody.picks, live: { title: "  " } } }],
    [{ picks: { ...validBody.picks, die: { title: 42 } } }],
    [{ ...validBody, eulogy: "x".repeat(LIMITS.eulogy + 1) }],
    [{ picks: { ...validBody.picks, bye: { title: "x".repeat(LIMITS.title + 1) } } }],
    [{ picks: { ...validBody.picks, die: { ...validBody.picks.die, rather: "nope" } } }],
    [{ picks: { ...validBody.picks, die: { ...validBody.picks.die, rather: { title: "" } } } }],
    [{ picks: { ...validBody.picks, live: { ...validBody.picks.live, rather: { title: "x".repeat(LIMITS.title + 1) } } } }],
  ])("rejects %j", (body) => {
    expect(() => validateStoryInput(body)).toThrow(StoryValidationError);
  });
});

describe("buildStoryPrompt", () => {
  it("includes every card, answer and the eulogy inside player_input", () => {
    const prompt = buildStoryPrompt(validateStoryInput(validBody));
    expect(prompt).toMatch(/^<player_input>/);
    expect(prompt).toContain("How you lived: Ran a pub");
    expect(prompt).toContain("Their answer: In Bali");
    expect(prompt).toContain("Card detail: Haunts the pokies");
    expect(prompt).toContain("Gone too soon.");
    expect(prompt.indexOf("</player_input>")).toBeGreaterThan(prompt.indexOf("Gone too soon."));
  });

  it("describes the would-rather card when it differs, and notes when it matches", () => {
    const prompt = buildStoryPrompt(validateStoryInput({
      ...validBody,
      picks: {
        ...validBody.picks,
        die: { ...validBody.picks.die, rather: { title: "In my sleep", description: "Peaceful" } },
        live: { ...validBody.picks.live, rather: { title: "Ran a pub" } },
      },
    }));
    expect(prompt).toContain("What they would rather: In my sleep");
    expect(prompt).toContain("    Card detail: Peaceful");
    expect(prompt).toContain("This is also what they would rather.");
    expect(prompt.indexOf("What they would rather")).toBeLessThan(prompt.indexOf("</player_input>"));
  });

  it("notes a missing eulogy", () => {
    expect(buildStoryPrompt(validateStoryInput({ ...validBody, eulogy: "" }))).toContain("did not write a eulogy");
  });
});

describe("generateLifeStory", () => {
  const input = validateStoryInput(validBody);

  it("posts to the Messages API and joins the text blocks", async () => {
    const fetchImpl = jest.fn<FetchFn>().mockResolvedValue(
      okJson({ content: [{ type: "text", text: "You lived. " }, { type: "text", text: "Then you didn't." }] }),
    );
    const story = await generateLifeStory(input, { apiKey: "test-key", fetchImpl });
    expect(story).toBe("You lived. Then you didn't.");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(DEFAULT_STORY_MODEL);
    expect(body.max_tokens).toBe(STORY_MAX_TOKENS);
  });

  it("uses a model override", async () => {
    const fetchImpl = jest.fn<FetchFn>().mockResolvedValue(okJson({ content: [{ type: "text", text: "Hi" }] }));
    await generateLifeStory(input, { apiKey: "k", model: "other-model", fetchImpl });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).model).toBe("other-model");
  });

  it("throws StoryUpstreamError with the status on a non-200", async () => {
    const fetchImpl = jest.fn<FetchFn>().mockResolvedValue({ ok: false, status: 529 } as Response);
    await expect(generateLifeStory(input, { apiKey: "k", fetchImpl })).rejects.toMatchObject({ status: 529 });
  });

  it("throws when the reply has no text", async () => {
    const fetchImpl = jest.fn<FetchFn>().mockResolvedValue(okJson({ content: [] }));
    await expect(generateLifeStory(input, { apiKey: "k", fetchImpl })).rejects.toThrow(StoryUpstreamError);
  });

  it("times out", async () => {
    const fetchImpl = jest.fn<FetchFn>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    await expect(generateLifeStory(input, { apiKey: "k", fetchImpl, timeoutMs: 10 })).rejects.toThrow("timed out");
  });
});
