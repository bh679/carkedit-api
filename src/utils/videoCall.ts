/**
 * Server-side sanitisation for the host's video-call details.
 *
 * The client does the clever part (parsing a pasted invite into links, phone
 * numbers and codes) but the client is untrusted: anything reaching room state
 * is re-checked here. Every player renders these values, so a bad link is a
 * stored-XSS vector for the whole room — links are restricted to http/https,
 * phone numbers are rebuilt from an allowlist of dial characters, and codes are
 * stripped to alphanumerics.
 *
 * Invalid entries are dropped rather than failing the whole update, so one bad
 * line in a pasted invite never costs the host the rest of their details.
 */

export const MAX_ENTRIES = 8;
export const MAX_VALUE_LENGTH = 500;
export const MAX_LABEL_LENGTH = 60;
export const MAX_NOTES_LENGTH = 1000;

/** Kept in sync with PLATFORMS in carkedit-online/js/utils/video-call.js */
export const PLATFORM_SLUGS = [
  "zoom", "google-meet", "teams", "discord", "whatsapp", "facetime",
  "webex", "skype", "jitsi", "whereby", "messenger", "telegram",
  "signal", "slack", "gotomeeting", "phone", "other",
] as const;

export type VideoCallKind = "link" | "phone" | "code";

export interface SanitizedEntry {
  kind: VideoCallKind;
  platform: string;
  value: string;
  label: string;
}

export interface SanitizedVideoCall {
  entries: SanitizedEntry[];
  notes: string;
}

const PLATFORM_SET = new Set<string>(PLATFORM_SLUGS);

/** Dial characters a phone app understands: digits, +, and DTMF pause/extension marks. */
const PHONE_ALLOWED = /[^0-9+\s\-().,;#*]/g;
const CODE_ALLOWED = /[^0-9A-Za-z \-]/g;

function toLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}

function toPlatform(value: unknown): string {
  return typeof value === "string" && PLATFORM_SET.has(value) ? value : "other";
}

/**
 * http/https only. Rejects javascript:, data:, file: and anything unparseable.
 * Returns the normalised href, or null when the link can't be trusted.
 */
export function sanitizeLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const href = url.href;
  return href.length <= MAX_VALUE_LENGTH ? href : null;
}

/**
 * Rebuilds the dial string from allowed characters only. Requires at least 7
 * digits so meeting IDs and stray numbers don't become tappable "phone numbers".
 */
export function sanitizePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(PHONE_ALLOWED, "").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 32) return null;
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return cleaned;
}

/** Meeting IDs / passcodes / PINs: alphanumerics, spaces and hyphens. */
export function sanitizeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CODE_ALLOWED, "").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 64) return null;
  return cleaned;
}

function sanitizeEntry(raw: unknown): SanitizedEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const label = toLabel(entry.label);

  if (entry.kind === "link") {
    const value = sanitizeLink(entry.value);
    return value ? { kind: "link", platform: toPlatform(entry.platform), value, label } : null;
  }
  if (entry.kind === "phone") {
    const value = sanitizePhone(entry.value);
    return value ? { kind: "phone", platform: "phone", value, label } : null;
  }
  if (entry.kind === "code") {
    const value = sanitizeCode(entry.value);
    return value ? { kind: "code", platform: toPlatform(entry.platform), value, label } : null;
  }
  return null;
}

/** Collapses runs of blank lines and caps length; the client escapes it on render. */
export function sanitizeNotes(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_NOTES_LENGTH);
}

export function sanitizeVideoCall(data: unknown): SanitizedVideoCall {
  const payload = (data ?? {}) as Record<string, unknown>;
  const rawEntries = Array.isArray(payload.entries) ? payload.entries : [];
  const entries: SanitizedEntry[] = [];
  for (const raw of rawEntries) {
    if (entries.length >= MAX_ENTRIES) break;
    const entry = sanitizeEntry(raw);
    if (entry) entries.push(entry);
  }
  return { entries, notes: sanitizeNotes(payload.notes) };
}
