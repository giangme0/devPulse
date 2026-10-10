import { createHash } from "node:crypto";
export const categories = [
  "Copilot",
  "AI Native",
  "Agent tools",
  "Prompt engineering",
];
export function localClock(now = new Date(), zone = "Asia/Ho_Chi_Minh") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
export function isDue(now, config, lastDay) {
  const c = localClock(now, config.timezone);
  return (
    config.scheduleEnabled && c.time >= config.scheduleTime && c.day !== lastDay
  );
}
export function canonicalUrl(input) {
  const u = new URL(input);
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("URL không hợp lệ");
  u.hash = "";
  for (const k of [...u.searchParams.keys()])
    if (/^(utm_|ref$|source$|fbclid$|gclid$)/i.test(k))
      u.searchParams.delete(k);
  u.searchParams.sort();
  u.hostname = u.hostname.toLowerCase();
  u.pathname = u.pathname.replace(/\/$/, "") || "/";
  return u.toString();
}
export const hash = (s) => createHash("sha256").update(s).digest("hex");
export function plain(s = "") {
  return String(s)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code) => {
      const n =
        code[0].toLowerCase() === "x"
          ? parseInt(code.slice(1), 16)
          : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&(?:rsquo|lsquo);/g, "'")
    .replace(/&(?:rdquo|ldquo);/g, '"')
    .replace(/&(?:mdash|ndash);/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}
export function classify(title, content = "") {
  const t = `${title} ${content}`.toLowerCase();
  let category = /copilot/.test(t)
    ? "Copilot"
    : /prompt|structured output|instruction/.test(t)
      ? "Prompt engineering"
      : /mcp|tool.call|agent|extension/.test(t)
        ? "Agent tools"
        : "AI Native";
  let score = 0;
  for (const [re, n] of [
    [/copilot/, 5],
    [/agent|mcp|tool.call/, 3],
    [/prompt|context|instruction|structured output/, 3],
    [/evaluation|evals|workflow|sdk|developer|code|repository/, 2],
    [/ai|llm|language model/, 1],
  ])
    if (re.test(t)) score += n;
  if (/funding|valuation|raised \$|sponsored/.test(t)) score -= 4;
  return { category, rank: Math.max(0, score) };
}
export function calculateCost(usage, prices) {
  if (
    !prices ||
    ["input", "cached", "output"].some((k) => typeof prices[k] !== "number")
  )
    return null;
  const input = usage.input_tokens || 0,
    cached = Math.min(input, usage.input_tokens_details?.cached_tokens || 0),
    output = usage.output_tokens || 0;
  return (
    ((input - cached) * prices.input +
      cached * prices.cached +
      output * prices.output) /
    1e6
  );
}
export function validateSummary(s) {
  if (
    !s ||
    !categories.includes(s.category) ||
    !["xem", "theo_doi", "bo_qua"].includes(s.recommendation)
  )
    throw new Error("AI trả về phân loại không hợp lệ");
  for (const key of ["relevance", "actionable", "hype"])
    if (!Number.isInteger(s[key]) || s[key] < 0 || s[key] > 10)
      throw new Error("Điểm AI không hợp lệ");
  for (const [k, max] of [
    ["key_points", 3],
    ["limitations", 2],
  ])
    if (
      !Array.isArray(s[k]) ||
      !s[k].length ||
      s[k].length > max ||
      s[k].some((x) => typeof x !== "string" || !x.trim() || x.length > 1200)
    )
      throw new Error(`Nội dung AI không hợp lệ: ${k} cần 1-${max} ý, mỗi ý không quá 1200 ký tự`);
  for (const k of ["reason", "evidence"])
    if (typeof s[k] !== "string" || !s[k].trim() || s[k].length > 1500)
      throw new Error("Thiếu căn cứ AI");
  return s;
}
export function validateTranslation(translation, source) {
  const keys = ["title", "reason", "evidence", "key_points", "limitations"];
  if (
    !translation ||
    Object.keys(translation).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(translation, key))
  )
    throw new Error("Bản dịch không đúng schema");
  for (const key of ["title", "reason", "evidence"])
    if (
      typeof translation[key] !== "string" ||
      !translation[key].trim() ||
      translation[key].length > 1500
    )
      throw new Error("Nội dung bản dịch không hợp lệ");
  for (const key of ["key_points", "limitations"])
    if (
      !Array.isArray(translation[key]) ||
      translation[key].length !== source[key].length ||
      translation[key].some(
        (value) => typeof value !== "string" || !value.trim() || value.length > 1200,
      )
    )
      throw new Error("Số lượng ý trong bản dịch không khớp");
  const protectedTokens = (text) =>
    (text.match(/`[^`]+`|https?:\/\/[^\s"'<>`]+/g) || [])
      .map((value) => value.startsWith("http") ? value.replace(/[.,;:!?)\]}]+$/, "") : value)
      .sort();
  const monthNumbers = new Map(
    "january february march april may june july august september october november december"
      .split(" ")
      .flatMap((month, index) => [[month, index + 1], [month.slice(0, 3), index + 1]]),
  );
  const numbers = (text) => {
    const date = text
      .replace(
        /\b(january|february|march|april|may|june|july|august|september|october|november|december)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi,
        (_match, month, day) => `${day} ${monthNumbers.get(month.toLowerCase())}`,
      )
      .replace(
        /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\.?\b/gi,
        (_match, day, month) => `${day} ${monthNumbers.get(month.toLowerCase())}`,
      )
      .replace(/\b(\d{1,2})\s+tháng\s+(\d{1,2})\b/gi, "$1 $2");
    return (date.match(/\d+(?:[.,]\d+)*(?:%|x)?/gi) || []).sort();
  };
  for (const key of keys) {
    const originals = Array.isArray(source[key]) ? source[key] : [source[key]];
    const translations = Array.isArray(translation[key]) ? translation[key] : [translation[key]];
    for (const [index, original] of originals.entries()) {
      const translated = translations[index];
      if (
        JSON.stringify(protectedTokens(original)) !== JSON.stringify(protectedTokens(translated)) ||
        JSON.stringify(numbers(original)) !== JSON.stringify(numbers(translated))
      )
        throw new Error(`Bản dịch làm thay đổi URL, code hoặc số liệu/phiên bản: ${key}`);
    }
  }
  const original = JSON.stringify(source);
  const translated = JSON.stringify(translation);
  for (const term of [
    "AI Native",
    "agent",
    "MCP",
    "prompt engineering",
    "context window",
    "tool calling",
    "structured output",
  ])
    if (original.toLowerCase().includes(term.toLowerCase()) && !translated.includes(term))
      throw new Error(`Bản dịch làm thay đổi technical keyword: ${term}`);
  return translation;
}
