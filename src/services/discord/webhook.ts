/**
 * Discord webhook integration for carkedit-api lifecycle events
 * (game start, game finish, account creation).
 *
 * Patterned on carkedit-deploy/src/notifications/discord.ts: graceful HTTP
 * (5s abort timeout, logs warnings, never throws), and an injectable
 * `fetchImpl` so tests can assert call shape without hitting the network.
 *
 * One env var drives the destination URL: `DISCORD_APP_WEBHOOK_URL`. Each
 * deployed box sets it to the appropriate channel webhook (dev + staging
 * share the "CarkedIt Online - DevAPP" hook; prod uses a separate prod
 * channel hook). If unset, calls log a debug line and return.
 */
export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: DiscordEmbedField[];
  timestamp?: string;
  footer?: { text: string };
}

export const COLOR_GAME_START = 0x10b981;
export const COLOR_GAME_FINISH = 0x6366f1;
export const COLOR_ACCOUNT_CREATED = 0xf59e0b;

const DISCORD_TIMEOUT_MS = 5000;

export interface PostOptions {
  /** Override the env-var lookup (used by callers that already resolved it). */
  webhookUrl?: string;
  /** Test seam — inject a stub fetch. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam — inject a stub logger. Defaults to `console`. */
  logger?: Pick<Console, "warn" | "debug">;
}

/**
 * POST a single embed to the configured Discord webhook.
 *
 * Returns `true` on a 2xx response, `false` otherwise (missing URL,
 * timeout, non-2xx, network error). Never throws — caller does not need
 * to wrap in try/catch, but call-site guards are still recommended in
 * sensitive paths (e.g. Colyseus room callbacks).
 */
export async function postWebhookEmbed(
  embed: DiscordEmbed,
  opts: PostOptions = {},
): Promise<boolean> {
  const url = opts.webhookUrl ?? process.env.DISCORD_APP_WEBHOOK_URL;
  const log = opts.logger ?? console;
  if (!url) {
    log.debug?.(
      `[CarkedIt Discord] no webhook url configured; skipping discord post (title="${embed.title}")`,
    );
    return false;
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn(
        `[CarkedIt Discord] webhook returned non-2xx (status=${res.status}, title="${embed.title}")`,
      );
      return false;
    }
    return true;
  } catch (err: any) {
    log.warn(
      `[CarkedIt Discord] webhook post failed (title="${embed.title}"):`,
      err?.message ?? err,
    );
    return false;
  } finally {
    clearTimeout(t);
  }
}

export interface GameStartEmbedOpts {
  mode: "online";
  roomCode?: string | null;
  hostName?: string | null;
  playerCount: number;
  apiVersion: string;
}

export function buildGameStartEmbed(opts: GameStartEmbedOpts): DiscordEmbed {
  const fields: DiscordEmbedField[] = [
    { name: "Mode", value: opts.mode, inline: true },
    { name: "Players", value: String(opts.playerCount), inline: true },
  ];
  if (opts.hostName) {
    fields.push({ name: "Host", value: truncate(opts.hostName, 64), inline: true });
  }
  if (opts.roomCode) {
    fields.push({ name: "Room", value: opts.roomCode, inline: true });
  }
  return {
    title: "Game started",
    color: COLOR_GAME_START,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: `carkedit-api v${opts.apiVersion}` },
  };
}

export interface GameFinishEmbedOpts {
  mode: "online" | "local";
  roomCode?: string | null;
  hostName?: string | null;
  winnerName?: string | null;
  winnerScore?: number | null;
  playerCount: number;
  rounds: number;
  durationSeconds?: number | null;
  apiVersion: string;
}

export function buildGameFinishEmbed(opts: GameFinishEmbedOpts): DiscordEmbed {
  const fields: DiscordEmbedField[] = [
    { name: "Mode", value: opts.mode, inline: true },
    { name: "Players", value: String(opts.playerCount), inline: true },
    { name: "Rounds", value: String(opts.rounds), inline: true },
  ];
  if (opts.winnerName) {
    const winnerValue =
      opts.winnerScore == null
        ? truncate(opts.winnerName, 64)
        : `${truncate(opts.winnerName, 48)} (${opts.winnerScore})`;
    fields.push({ name: "Winner", value: winnerValue, inline: true });
  }
  if (opts.hostName) {
    fields.push({ name: "Host", value: truncate(opts.hostName, 64), inline: true });
  }
  if (opts.roomCode) {
    fields.push({ name: "Room", value: opts.roomCode, inline: true });
  }
  if (opts.durationSeconds != null && Number.isFinite(opts.durationSeconds)) {
    fields.push({ name: "Duration", value: formatDuration(opts.durationSeconds), inline: true });
  }
  return {
    title: "Game finished",
    color: COLOR_GAME_FINISH,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: `carkedit-api v${opts.apiVersion}` },
  };
}

export interface AccountCreatedEmbedOpts {
  displayName: string;
  userId: string;
  signUpMethod: "firebase" | "anonymous";
  apiVersion: string;
}

export function buildAccountCreatedEmbed(opts: AccountCreatedEmbedOpts): DiscordEmbed {
  const fields: DiscordEmbedField[] = [
    { name: "Name", value: truncate(opts.displayName, 64), inline: true },
    { name: "Sign-up", value: opts.signUpMethod, inline: true },
    { name: "User ID", value: opts.userId.slice(0, 12), inline: true },
  ];
  return {
    title: "New account",
    color: COLOR_ACCOUNT_CREATED,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: `carkedit-api v${opts.apiVersion}` },
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}
