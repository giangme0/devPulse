import { environment } from "./environment.js";

const sensitiveField = /^(authorization|proxyauthorization|cookie|setcookie|password|secret|(?:openai|github)?apikey|(?:openai|github)?key|(?:access|refresh|github)?token|clientsecret)$/i;
const sensitiveQuery = /key|token|password|secret|auth|credential/i;

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys())
      if (sensitiveQuery.test(key)) url.searchParams.set(key, "[REDACTED]");
    if (url.username) url.username = "[REDACTED]";
    if (url.password) url.password = "[REDACTED]";
    return url.toString();
  } catch {
    return value;
  }
}

function sanitizeString(value) {
  const text = value
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object")
      return JSON.stringify(sanitize(parsed));
  } catch {}
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return sanitizeUrl(text);
  return text.replace(/https?:\/\/[^\s"'<>()[\]]+/gi, sanitizeUrl);
}

export function sanitize(value, key = "") {
  if (sensitiveField.test(key.replace(/[-_]/g, ""))) return "[REDACTED]";
  if (typeof value === "string") return sanitizeString(value);
  if (value instanceof Error)
    return { name: value.name, message: sanitizeString(value.message), stack: sanitizeString(value.stack || "") };
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]),
    );
  if (typeof value === "bigint") return value.toString();
  return value;
}

function compact(value, depth = 0) {
  if (typeof value === "string")
    return value.length > 240 ? `${value.slice(0, 240)}... (${value.length} chars)` : value;
  if (Array.isArray(value))
    return { count: value.length, sample: value.slice(0, 3).map((item) => compact(item, depth + 1)) };
  if (value && typeof value === "object") {
    if (depth >= 4) return { fields: Object.keys(value).length };
    const entries = Object.entries(value).filter(([key]) => key !== "stack");
    return {
      ...Object.fromEntries(entries.slice(0, 12).map(([key, item]) => [key, compact(item, depth + 1)])),
      ...(entries.length > 12 ? { omittedFields: entries.length - 12 } : {}),
    };
  }
  return value;
}

export function summarizeResponse(response, url = "", status = 200) {
  const bytes = typeof response === "string" ? Buffer.byteLength(response) : undefined;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      return status >= 400 ? { bytes, error: compact(response) } : { bytes };
    }
  }
  if (status >= 400) return compact(response);
  if (new URL(url || "http://localhost", "http://localhost").pathname === "/api/state" && response && typeof response === "object") {
    const run = response.lastRun;
    let details = run?.details;
    if (typeof details === "string") {
      try { details = JSON.parse(details); } catch { details = {}; }
    }
    const today = response.dates?.find((date) => date.day === response.today);
    return compact({
      running: response.running,
      progress: response.progress || undefined,
      activeAI: response.activeAI,
      today: response.today,
      total: today?.total ?? 0,
      unread: today?.unread ?? 0,
      lastRun: run ? {
        id: run.id,
        status: run.status,
        inserted: details?.inserted,
        summarized: details?.summarized,
        sourceErrors: details?.sources?.filter((source) => !source.ok).map((source) => `${source.id}: ${source.error}`),
        aiErrors: details?.aiErrors?.map((error) => typeof error === "string" ? error : JSON.stringify(error)),
        aiSkipped: details?.aiSkipped,
      } : null,
    });
  }
  if (Array.isArray(response)) return { count: response.length };
  if (Array.isArray(response?.items)) return { total: response.total, count: response.items.length };
  if (response?.id && response.title && response.url)
    return compact({ id: response.id, title: response.title, source: response.source, read: response.read, bookmarked: response.bookmarked });
  if (response?.usage)
    return compact({ id: response.id, status: response.status, usage: response.usage });
  return compact(response);
}

function write(level, event, fields) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  if (Number(fields.status) >= 400 && level === "info")
    level = Number(fields.status) >= 500 ? "error" : "warn";
  const { level: threshold, format } = environment.logging();
  if (levels[level] < (levels[threshold] ?? levels.info)) return;
  const safe = sanitize(fields);
  const { response, ...metadata } = safe;
  const details = threshold === "debug" ? safe : {
    ...compact(metadata),
    ...(Object.hasOwn(safe, "response") ? {
      response: summarizeResponse(response, safe.url, safe.status),
    } : {}),
  };
  const entry = sanitize({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
  });
  const output = format === "json" ? JSON.stringify(entry)
    : `${entry.timestamp} ${level.toUpperCase().padEnd(5)} ${event} ${Object.entries(details)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")}`;
  (level === "error" ? console.error : console.log)(output);
}

export const logger = {
  debug: (event, fields = {}) => write("debug", event, fields),
  info: (event, fields = {}) => write("info", event, fields),
  warn: (event, fields = {}) => write("warn", event, fields),
  error: (event, fields = {}) => write("error", event, fields),
};