import { jest } from "@jest/globals";
import {
  postWebhookEmbed,
  buildGameStartEmbed,
  buildGameFinishEmbed,
  buildAccountCreatedEmbed,
  COLOR_GAME_START,
  COLOR_GAME_FINISH,
  COLOR_ACCOUNT_CREATED,
} from "./webhook.js";

const ENV_URL = "https://discord.com/api/webhooks/123/abc";

type FetchFn = typeof fetch;

function makeFetchMock(): jest.Mock<FetchFn> {
  return jest.fn<FetchFn>();
}

function makeLogger() {
  const warn = jest.fn();
  const debug = jest.fn();
  return { warn, debug, logger: { warn, debug } as any };
}

function okResponse(): Response {
  return { ok: true, status: 204 } as Response;
}

function errResponse(status: number): Response {
  return { ok: false, status } as Response;
}

describe("postWebhookEmbed", () => {
  it("short-circuits and logs debug when no webhook URL is configured", async () => {
    const fetchImpl = makeFetchMock();
    const { logger, debug } = makeLogger();
    const result = await postWebhookEmbed(
      { title: "T", color: 0 },
      { webhookUrl: undefined, fetchImpl, logger },
    );
    expect(result).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("no webhook url configured"));
  });

  it("POSTs JSON with the embed wrapped in an `embeds` array", async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockResolvedValue(okResponse());
    const { logger } = makeLogger();
    const embed = { title: "Game started", color: 1 };
    const result = await postWebhookEmbed(embed, {
      webhookUrl: ENV_URL,
      fetchImpl,
      logger,
    });
    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(ENV_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ embeds: [embed] });
    expect(init.signal).toBeDefined();
  });

  it("logs at warn and returns false on a non-2xx response — does NOT throw", async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockResolvedValue(errResponse(429));
    const { logger, warn } = makeLogger();
    const result = await postWebhookEmbed(
      { title: "T", color: 0 },
      { webhookUrl: ENV_URL, fetchImpl, logger },
    );
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("status=429"));
  });

  it("logs at warn and returns false on a thrown fetch error — does NOT propagate", async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockRejectedValue(new Error("network down"));
    const { logger, warn } = makeLogger();
    const result = await postWebhookEmbed(
      { title: "T", color: 0 },
      { webhookUrl: ENV_URL, fetchImpl, logger },
    );
    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("webhook post failed"),
      "network down",
    );
  });

  it("falls back to process.env.DISCORD_APP_WEBHOOK_URL when webhookUrl opt is omitted", async () => {
    const prev = process.env.DISCORD_APP_WEBHOOK_URL;
    process.env.DISCORD_APP_WEBHOOK_URL = ENV_URL;
    try {
      const fetchImpl = makeFetchMock();
      fetchImpl.mockResolvedValue(okResponse());
      const { logger } = makeLogger();
      await postWebhookEmbed({ title: "T", color: 0 }, { fetchImpl, logger });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe(ENV_URL);
    } finally {
      if (prev === undefined) delete process.env.DISCORD_APP_WEBHOOK_URL;
      else process.env.DISCORD_APP_WEBHOOK_URL = prev;
    }
  });
});

describe("buildGameStartEmbed", () => {
  it("renders title, color, and inline fields", () => {
    const embed = buildGameStartEmbed({
      mode: "online",
      roomCode: "FRUIT-BAT",
      hostName: "Brennan",
      playerCount: 3,
      apiVersion: "0.02.0009",
    });
    expect(embed.title).toBe("Game started");
    expect(embed.color).toBe(COLOR_GAME_START);
    expect(embed.footer?.text).toBe("carkedit-api v0.02.0009");
    const byName = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(byName.Mode).toBe("online");
    expect(byName.Players).toBe("3");
    expect(byName.Host).toBe("Brennan");
    expect(byName.Room).toBe("FRUIT-BAT");
  });

  it("omits host/room fields when missing", () => {
    const embed = buildGameStartEmbed({
      mode: "online",
      playerCount: 2,
      apiVersion: "0.02.0009",
    });
    const names = (embed.fields ?? []).map((f) => f.name);
    expect(names).not.toContain("Host");
    expect(names).not.toContain("Room");
  });
});

describe("buildGameFinishEmbed", () => {
  it("includes winner with score, duration, and rounds", () => {
    const embed = buildGameFinishEmbed({
      mode: "online",
      hostName: "Brennan",
      roomCode: "FRUIT-BAT",
      winnerName: "Alice",
      winnerScore: 7,
      playerCount: 4,
      rounds: 5,
      durationSeconds: 612,
      apiVersion: "0.02.0009",
    });
    expect(embed.title).toBe("Game finished");
    expect(embed.color).toBe(COLOR_GAME_FINISH);
    const byName = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(byName.Winner).toBe("Alice (7)");
    expect(byName.Duration).toBe("10m 12s");
    expect(byName.Rounds).toBe("5");
    expect(byName.Players).toBe("4");
    expect(byName.Mode).toBe("online");
  });

  it("handles local mode without room code", () => {
    const embed = buildGameFinishEmbed({
      mode: "local",
      winnerName: "Solo",
      winnerScore: 3,
      playerCount: 1,
      rounds: 2,
      apiVersion: "0.02.0009",
    });
    const byName = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(byName.Mode).toBe("local");
    expect(byName.Room).toBeUndefined();
    expect(byName.Winner).toBe("Solo (3)");
  });
});

describe("buildAccountCreatedEmbed", () => {
  it("renders firebase sign-up with truncated user id", () => {
    const embed = buildAccountCreatedEmbed({
      displayName: "Brennan Hatton",
      userId: "usr_12345678-aaaa-bbbb-cccc-dddddddddddd",
      signUpMethod: "firebase",
      apiVersion: "0.02.0009",
    });
    expect(embed.title).toBe("New account");
    expect(embed.color).toBe(COLOR_ACCOUNT_CREATED);
    const byName = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(byName.Name).toBe("Brennan Hatton");
    expect(byName["Sign-up"]).toBe("firebase");
    expect(byName["User ID"]).toBe("usr_12345678");
  });

  it("does not include email anywhere in the embed", () => {
    const embed = buildAccountCreatedEmbed({
      displayName: "Test",
      userId: "usr_abcdef0123",
      signUpMethod: "firebase",
      apiVersion: "0.02.0009",
    });
    const serialized = JSON.stringify(embed);
    expect(serialized).not.toMatch(/@/);
  });
});
