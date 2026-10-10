import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db.js";
import { Config } from "../src/config.js";
import { AI, schema } from "../src/ai.js";
import { Pipeline } from "../src/pipeline.js";
import {
  canonicalUrl,
  calculateCost,
  localClock,
  isDue,
  validateTranslation,
} from "../src/utils.js";
import { translationPromptVersion } from "../src/ai.js";
import { parseFeed, collect } from "../src/sources.js";
import { createApp } from "../src/server.js";
import { createEnvironment } from "../src/environment.js";
import { sanitize, summarizeResponse, logger } from "../src/logger.js";
const testEnvironment = createEnvironment({ env: {}, envFile: false });
const summary = {
  category: "Copilot",
  relevance: 8,
  actionable: 8,
  hype: 2,
  recommendation: "xem",
  reason: "Phù hợp với Copilot.",
  evidence: "Chỉ dựa trên RSS excerpt.",
  key_points: ["Nội dung kỹ thuật."],
  limitations: ["Chưa chạy thử."],
};
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devpulse-test-"));
  const config = new Config(dir, { environment: testEnvironment });
  const store = new Store(path.join(dir, "test.db"));
  return {
    dir,
    config,
    store,
    done() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};
const item = (i) => ({
  title: "GitHub Copilot agent " + i,
  url: "https://example.com/" + i,
  source: "test",
  content: "Agent instructions and tools.",
});
function okFetch() {
  return async (_url, options) => {
    const payload = JSON.parse(options.body);
    const result = payload.text.format.name === "devpulse_translation_vi"
      ? JSON.parse(payload.input)
      : summary;
    return new Response(
      JSON.stringify({
        id: "resp_test",
        status: "completed",
        usage: {
          input_tokens: 100,
          cached_tokens: 0,
          output_tokens: 50,
          input_tokens_details: { cached_tokens: 20 },
        },
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(result) }],
          },
        ],
      }),
      { status: 200 },
    );
  };
}
test("UTC+7 schedule, startup catch-up and same-day dedup", () => {
  const c = {
    timezone: "Asia/Ho_Chi_Minh",
    scheduleTime: "06:00",
    scheduleEnabled: true,
  };
  assert.deepEqual(localClock(new Date("2026-10-09T23:00:00Z"), c.timezone), {
    day: "2026-10-10",
    time: "06:00",
  });
  assert.equal(isDue(new Date("2026-10-09T22:59:00Z"), c, null), false);
  assert.equal(isDue(new Date("2026-10-10T04:00:00Z"), c, "2026-10-09"), true);
  assert.equal(isDue(new Date("2026-10-10T04:00:00Z"), c, "2026-10-10"), false);
});
test("structured logs redact credentials in objects, JSON responses and URLs", () => {
  const safe = sanitize({
    headers: { Authorization: "Bearer private-token" },
    params: { openaiKey: "private-key", q: "agent" },
    response: '{"access_token":"private-token","status":"ok"}',
    url: "https://example.com/feed?api_key=private-key&limit=3",
    error: "Failed https://example.com/feed?token=query-secret with sk-proj-12345678901234567890",
  });
  const output = JSON.stringify(safe);
  assert.ok(!output.includes("private-token"));
  assert.ok(!output.includes("private-key"));
  assert.ok(!output.includes("query-secret"));
  assert.ok(!output.includes("sk-proj-12345678901234567890"));
  assert.ok(output.includes("agent"));
  assert.ok(output.includes("limit=3"));
});
test("state log summary keeps failures and counts without history or settings", () => {
  const run = {
    id: 1, status: "partial",
    details: JSON.stringify({
      inserted: 18, summarized: 0,
      sources: [{ id: "microsoft", ok: true }, { id: "github", ok: false, error: "HTTP 403" }],
      aiErrors: [], aiSkipped: "Missing API key",
    }),
  };
  const result = summarizeResponse({
    running: false, activeAI: 0, today: "2026-10-10", lastRun: run, runs: [run],
    dates: [{ day: "2026-10-10", total: 18, unread: 18 }], settings: { profile: "private-profile" },
  }, "http://localhost:3000/api/state");
  assert.equal(result.total, 18);
  assert.equal(result.unread, 18);
  assert.equal(result.lastRun.status, "partial");
  assert.equal(result.lastRun.inserted, 18);
  assert.ok(JSON.stringify(result).includes("HTTP 403"));
  assert.ok(!JSON.stringify(result).includes("private-profile"));
  assert.equal(result.runs, undefined);
  assert.deepEqual(summarizeResponse(Array(50).fill({ content: "long article" })), { count: 50 });
  assert.deepEqual(summarizeResponse({ total: 100, items: Array(50).fill({ content: "long article" }) }), { total: 100, count: 50 });
  assert.deepEqual(summarizeResponse({ error: "Host denied" }, "/api/state", 403), { error: "Host denied" });
  assert.deepEqual(summarizeResponse("<rss>long feed</rss>"), { bytes: 20 });
  assert.equal(summarizeResponse({ lastRun: { details: "invalid" } }, "/api/state").lastRun.id, undefined);
});
test("logger supports concise text, JSON, levels and redacted debug payloads", () => {
  const saved = { level: process.env.LOG_LEVEL, format: process.env.LOG_FORMAT, log: console.log, error: console.error };
  const lines = [];
  try {
    process.env.LOG_LEVEL = "info";
    process.env.LOG_FORMAT = "text";
    console.log = console.error = (line) => lines.push(line);
    logger.debug("http.request", { params: { profile: "hidden" } });
    logger.info("http.response", { method: "GET", url: "/api/articles", status: 200, durationMs: 2, response: Array(50).fill({ content: "hidden" }) });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /INFO\s+http.response/);
    assert.ok(lines[0].includes('response={"count":50}'));
    assert.ok(!lines[0].includes("hidden"));
    process.env.LOG_FORMAT = "json";
    logger.info("http.response", {
      url: "/api/state", status: 200,
      response: { running: false, lastRun: { id: 1, status: "partial", details: JSON.stringify({ sources: [{ id: "github", ok: false, error: "HTTP 403" }] }) } },
    });
    assert.ok(lines.at(-1).includes("HTTP 403"));
    logger.info("http.response", { status: 403, response: { error: "Denied" } });
    assert.equal(JSON.parse(lines.at(-1)).level, "warn");
    process.env.LOG_LEVEL = "warn";
    logger.info("quiet");
    assert.equal(lines.length, 3);
    process.env.LOG_LEVEL = "debug";
    logger.debug("http.request", { params: { openaiKey: "private-key", profile: "full-profile" } });
    assert.equal(JSON.parse(lines.at(-1)).params.profile, "full-profile");
    assert.ok(!lines.at(-1).includes("private-key"));
    process.env.LOG_LEVEL = "info";
    logger.error("failure", { error: new Error("failed"), response: "x".repeat(10000), status: 500 });
    assert.ok(lines.at(-1).length < 1000);
    assert.ok(!lines.at(-1).includes('"stack"'));
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    if (saved.level === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = saved.level;
    if (saved.format === undefined) delete process.env.LOG_FORMAT; else process.env.LOG_FORMAT = saved.format;
  }
});
test("canonical dedup keeps original storage day and read state after re-ingestion", () => {
  const f = fixture();
  try {
    assert.equal(
      canonicalUrl("https://example.com/a/?utm_source=x#z"),
      "https://example.com/a",
    );
    assert.equal(f.store.ingest([item(1)], "2026-10-09"), 1);
    const a = f.store.get("SELECT * FROM articles");
    f.store.run("UPDATE articles SET read=1 WHERE id=?", a.id);
    assert.equal(
      f.store.ingest(
        [{ ...item(1), url: "https://example.com/1?utm_source=abc" }],
        "2026-10-10",
      ),
      0,
    );
    assert.equal(f.store.article(a.id).saved_day, "2026-10-09");
    assert.equal(f.store.article(a.id).read, 1);
  } finally {
    f.done();
  }
});
test("existing database migrates AI calls to task attribution without losing records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devpulse-migration-"));
  const file = path.join(dir, "old.db");
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE ai_calls(
    id INTEGER PRIMARY KEY,article_id TEXT,day TEXT NOT NULL,created_at TEXT NOT NULL,
    mode TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,input_tokens INTEGER,
    cached_tokens INTEGER,output_tokens INTEGER,cost REAL,reserved REAL NOT NULL,
    prices TEXT NOT NULL,error TEXT,response_id TEXT
  );
  INSERT INTO ai_calls(article_id,day,created_at,mode,model,status,reserved,prices)
  VALUES('legacy','2026-10-09','2026-10-09T00:00:00Z','auto','model','ok',0,'{}');`);
  legacy.close();
  const store = new Store(file);
  try {
    const row = store.get("SELECT * FROM ai_calls");
    assert.equal(row.article_id, "legacy");
    assert.equal(row.task, "summary");
    assert.ok(store.get("SELECT name FROM sqlite_master WHERE name='article_translations'"));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("cached input cost is not double counted", () => {
  assert.equal(
    calculateCost(
      {
        input_tokens: 1000000,
        input_tokens_details: { cached_tokens: 250000 },
        output_tokens: 100000,
      },
      { input: 0.4, cached: 0.1, output: 1.6 },
    ),
    0.485,
  );
  assert.equal(calculateCost({}, null), null);
});
test("RSS and Atom parsing plus reject DTD and HTML masquerading as feed", () => {
  const rss =
    "<rss><channel><item><title>A &amp; B</title><link>https://example.com/a</link><description><![CDATA[<p>Agent</p>]]></description></item></channel></rss>";
  assert.equal(parseFeed(rss, "x")[0].content, "Agent");
  assert.equal(
    parseFeed(
      rss.replace("<p>Agent</p>", "<!DOCTYPE html><p>Agent</p>"),
      "x",
    )[0].content,
    "Agent",
  );
  assert.equal(
    parseFeed(
      '<feed><entry><title>Test</title><link href="https://example.com/b"/><summary>context</summary></entry></feed>',
      "x",
    )[0].url,
    "https://example.com/b",
  );
  const atom = parseFeed(
    '<feed><entry><title>Prompt guide</title><link href="https://example.com/c"/><summary>&lt;p&gt;Use agents&lt;/p&gt;</summary><category term="Engineering"/></entry></feed>',
    "Atom source",
  )[0];
  assert.equal(atom.content, "Use agents");
  assert.deepEqual(atom.tags, ["Engineering"]);
  const cdata = parseFeed(
    "<rss><channel><item><title><![CDATA[OpenAI update]]></title><link>https://example.com/d</link><category><![CDATA[Product]]></category><description><![CDATA[<p>Launch</p>]]></description></item></channel></rss>",
    "RSS source",
  )[0];
  assert.equal(cdata.title, "OpenAI update");
  assert.equal(cdata.content, "Launch");
  assert.deepEqual(cdata.tags, ["Product"]);
  assert.equal(parseFeed(rss, "x", 0).length, 0);
  assert.equal(
    parseFeed(
      rss.replace(
        "</channel>",
        "<item><title>Second</title><link>https://example.com/second</link></item></channel>",
      ),
      "x",
      1,
    ).length,
    1,
  );
  assert.throws(() => parseFeed("<!DOCTYPE x><rss/>", "x"));
  assert.throws(() => parseFeed("<html><body>No</body></html>", "x"));
});
test("data-driven RSS sources filter keywords and categories before returning items", async () => {
  const config = {
    sources: {},
    rssSources: [
      {
        id: "simon",
        type: "atom",
        url: "https://example.com/simon.xml",
        limit: 10,
        include_keywords: ["prompt", "agent", "claude", "llm", "openai", "eval"],
        include_categories: [],
        weight: 1,
        enabled: true,
      },
      {
        id: "openai",
        type: "rss",
        url: "https://example.com/openai.xml",
        limit: 8,
        include_keywords: [],
        include_categories: ["Product", "Research", "Engineering"],
        weight: 0.9,
        enabled: true,
      },
      {
        id: "disabled",
        type: "rss",
        url: "https://example.com/disabled.xml",
        limit: 8,
        include_keywords: [],
        include_categories: [],
        weight: 1,
        enabled: false,
      },
    ],
  };
  const calls = [];
  const makeFeed = (entries) =>
    `<rss><channel>${entries.map(({ title, category }) => `<item><title>${title}</title><link>https://example.com/${encodeURIComponent(title)}</link><category>${category}</category></item>`).join("")}</channel></rss>`;
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers["User-Agent"], "DevPulse-Local/1.0");
    if (url.includes("simon"))
      return new Response(makeFeed([
        { title: "Prompt patterns", category: "Notes" },
        { title: "Weekly roundup", category: "Notes" },
      ]));
    return new Response(makeFeed([
      { title: "Product release", category: "Product" },
      { title: "Company event", category: "Events" },
    ]));
  };
  const result = await collect(config, fetcher);
  assert.deepEqual(calls, ["https://example.com/simon.xml", "https://example.com/openai.xml"]);
  assert.deepEqual(result.items.map((item) => item.title), ["Prompt patterns", "Product release"]);
  assert.deepEqual(result.items.map((item) => item.source), ["simon", "openai"]);
  assert.equal(result.items[0].metadata.source_weight, 1);
  assert.equal(result.items[1].metadata.source_weight, 0.9);
  assert.deepEqual(result.sources.map((source) => source.ok), [true, true]);
  const f = fixture();
  try {
    f.store.ingest([{ ...result.items[1], title: "AI agent workflow" }], "2026-10-10");
    assert.equal(f.store.get("SELECT rank FROM articles").rank, 5.4);
  } finally {
    f.done();
  }
});
test("source isolation preserves successful feeds when one fails", async () => {
  const config = {
    sources: { githubCopilot: true, microsoft: true },
    githubToken: "",
  };
  const fake = async (url) =>
    url.includes("github.blog")
      ? new Response(
          "<rss><channel><item><title>Copilot</title><link>https://example.com</link></item></channel></rss>",
        )
      : new Response("", { status: 403 });
  const r = await collect(config, fake);
  assert.equal(r.items.length, 1);
  assert.equal(r.sources.filter((x) => !x.ok).length, 1);
});
test("config secrets never returned; file permissions and model pricing reset", () => {
  const f = fixture();
  try {
    f.config.update({ openaiKey: "test-secret" });
    assert.equal(f.config.public().openaiKey, undefined);
    assert.equal(f.config.public().hasOpenaiKey, true);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(f.config.file).mode & 0o777, 0o600);
    f.config.update({ model: "another-model" });
    assert.equal(f.config.get().prices, null);
    assert.throws(() =>
      f.config.update({ dailyFeedUrl: "http://localhost/feed" }),
    );
  } finally {
    f.done();
  }
});
test("AI summary cached; usage charged once; full pipeline never exceeds ten automatic requests", async () => {
  const f = fixture();
  try {
    f.config.update({ openaiKey: "test", dailyBudget: 10 });
    const day = localClock().day;
    let activeRequests = 0,
      peakRequests = 0;
    const fetcher = async (_url, options) => {
      activeRequests++;
      peakRequests = Math.max(peakRequests, activeRequests);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const payload = JSON.parse(options.body);
        const result = payload.text.format.name === "devpulse_translation_vi"
          ? JSON.parse(payload.input)
          : summary;
        return new Response(
          JSON.stringify({
            id: "resp_test",
            status: "completed",
            usage: {
              input_tokens: 100,
              cached_tokens: 0,
              output_tokens: 50,
              input_tokens_details: { cached_tokens: 20 },
            },
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: JSON.stringify(result) }],
              },
            ],
          }),
          { status: 200 },
        );
      } finally {
        activeRequests--;
      }
    };
    const ai = new AI(f.store, f.config, fetcher);
    const collector = async () => ({
      items: Array.from({ length: 18 }, (_, i) => item(i)),
      sources: [{ id: "test", name: "test", ok: true, count: 18 }],
    });
    const pipeline = new Pipeline(f.store, f.config, ai, collector);
    await pipeline.run();
    await pipeline.run();
    assert.equal(peakRequests, 3);
    assert.equal(f.store.get("SELECT count(*) n FROM articles").n, 18);
    assert.equal(
      f.store.get("SELECT count(*) n FROM ai_calls WHERE task='summary'").n,
      10,
    );
    assert.equal(
      f.store.get("SELECT count(*) n FROM ai_calls WHERE task='translation'").n,
      10,
    );
    assert.deepEqual(
      f.store.usage("2000-01-01").rows.map((row) => [row.task, row.requests]),
      [
        ["summary", 10],
        ["translation", 10],
      ],
    );
    assert.equal(
      f.store.get("SELECT count(*) n FROM articles WHERE summary IS NOT NULL")
        .n,
      10,
    );
    const a = f.store.get(
      "SELECT id FROM articles WHERE summary IS NOT NULL LIMIT 1",
    );
    await ai.summarize(a.id);
    assert.equal(
      f.store.get("SELECT count(*) n FROM ai_calls WHERE task='summary'").n,
      10,
    );
    assert.equal(f.store.meta("lastScheduledDay"), day);
  } finally {
    f.done();
  }
});
test("summary request schema matches local validation limits", () => {
  for (const key of ["relevance", "actionable", "hype"]) {
    assert.equal(schema.properties[key].minimum, 0);
    assert.equal(schema.properties[key].maximum, 10);
  }
  for (const [key, maximum] of [["key_points", 3], ["limitations", 2]]) {
    assert.equal(schema.properties[key].minItems, 1);
    assert.equal(schema.properties[key].maxItems, maximum);
    assert.equal(schema.properties[key].items.maxLength, 1200);
  }
  for (const key of ["reason", "evidence"])
    assert.equal(schema.properties[key].maxLength, 1500);
});
test("translation accepts reordered numbers and URL punctuation but preserves each field", () => {
  const source = {
    title: "MCP v2 supports 3 tools",
    reason: "See https://example.com/v2.\nMore details.",
    evidence: "Version 1.2.3 supports 4 clients.",
    key_points: ["Run `node check.js` with 2 inputs."],
    limitations: ["Only 5 repositories."],
  };
  const translated = {
    ...source,
    title: "Có 3 tools trong MCP v2",
    reason: "Xem https://example.com/v2 để biết thêm chi tiết.",
    evidence: "Hỗ trợ 4 clients ở version 1.2.3.",
  };
  assert.equal(validateTranslation(translated, source), translated);
  for (const reason of ["Xem https://example.com/v3", "Xem https://example.com/v2/other"])
    assert.throws(() => validateTranslation({ ...translated, reason }, source), /số liệu\/phiên bản/);
  assert.throws(() => validateTranslation({ ...translated, evidence: "Version 1.2.3 supports 5 clients.", limitations: ["Only 4 repositories."] }, source), /số liệu\/phiên bản/);
  assert.throws(() => validateTranslation({ ...translated, key_points: ["Run `node other.js` with 2 inputs."] }, source), /số liệu\/phiên bản/);
  assert.throws(() => validateTranslation({ ...translated, title: "MCP v2 supports 3 tools and 3 clients" }, source), /số liệu\/phiên bản/);
});
test("translation accepts English month dates localized to Vietnamese numeric dates", () => {
  const source = {
    title: "GitHub Copilot weekly releases — October 5",
    reason: "The update was published on October 5.",
    evidence: "Release date: October 5.",
    key_points: [],
    limitations: [],
  };
  const translated = {
    title: "Bản phát hành hàng tuần của GitHub Copilot — ngày 5 tháng 10",
    reason: "Bản cập nhật được phát hành vào ngày 5 tháng 10.",
    evidence: "Ngày phát hành: 5 tháng 10.",
    key_points: [],
    limitations: [],
  };
  assert.equal(validateTranslation(translated, source), translated);
  assert.throws(
    () => validateTranslation({ ...translated, title: "... ngày 6 tháng 10" }, source),
    /số liệu\/phiên bản/,
  );
});
test("translation schema preserves technical terms, URLs, code, and numbers", () => {
  const source = {
    title: "AI Native agent MCP v2.1 has 3 tools: https://example.com/api",
    reason: "Supports prompt engineering.",
    evidence: "Model version 1.2.3; context window is untested.",
    key_points: ["Use tool calling in structured output."],
    limitations: ["Only 2 repositories; run `node check.js` first."],
  };
  const translated = {
    title: "AI Native agent MCP v2.1 có 3 tools: https://example.com/api",
    reason: "Hỗ trợ prompt engineering.",
    evidence: "Model version 1.2.3; context window chưa được kiểm tra.",
    key_points: ["Dùng tool calling trong structured output."],
    limitations: ["Chỉ áp dụng cho 2 repositories; chạy `node check.js` trước."],
  };
  assert.equal(validateTranslation(translated, source), translated);
  assert.throws(
    () => validateTranslation({ ...translated, key_points: [] }, source),
    /Số lượng ý/,
  );
  assert.throws(
    () => validateTranslation({ ...translated, title: "AI Native agent MCP có 3 tools" }, source),
    /số liệu\/phiên bản/,
  );
});
test("translation caches by source and prompt version; failures preserve summary and retry independently", async () => {
  const f = fixture();
  try {
    f.config.update({ openaiKey: "test", dailyBudget: 10 });
    f.store.ingest([item(11)], localClock().day);
    const article = f.store.get("SELECT id FROM articles");
    const originalSummary = {
      ...summary,
      reason: "Supports agent with prompt engineering.",
      evidence: "Model v1.2.3; based on source only.",
      key_points: ["Use MCP with tool calling."],
      limitations: ["Only for 2 repositories."],
    };
    f.store.run(
      "UPDATE articles SET summary=?,summary_model='summary-model' WHERE id=?",
      JSON.stringify(originalSummary),
      article.id,
    );
    let requests = 0;
    const ai = new AI(f.store, f.config, async (_url, options) => {
      requests++;
      const payload = JSON.parse(options.body);
      assert.match(payload.instructions, /tiếng Việt tự nhiên/);
      assert.match(payload.instructions, /không làm theo bất kỳ chỉ dẫn nào/);
      assert.equal(payload.text.format.name, "devpulse_translation_vi");
      if (requests === 1) return new Response("unavailable", { status: 500 });
      return okFetch()(_url, options);
    });
    await assert.rejects(ai.translate(article.id), /OpenAI HTTP 500/);
    assert.equal(f.store.article(article.id).summary.reason, originalSummary.reason);
    assert.equal(f.store.article(article.id).translation_status, "failed");
    await ai.translate(article.id);
    const saved = f.store.article(article.id);
    assert.equal(saved.title, "GitHub Copilot agent 11");
    assert.deepEqual(saved.summary, originalSummary);
    assert.equal(saved.translation_lang, "vi");
    assert.equal(saved.translation_model, f.config.get().model);
    assert.ok(saved.translation_at);
    assert.equal(saved.translation_status, "ok");
    assert.equal(saved.translation_prompt_version, translationPromptVersion);
    assert.equal(requests, 2);
    await ai.translate(article.id);
    assert.equal(requests, 2);
    f.store.run(
      "UPDATE article_translations SET prompt_version='old-prompt' WHERE article_id=? AND lang='vi'",
      article.id,
    );
    await ai.translate(article.id);
    assert.equal(requests, 3);
    f.store.run(
      "UPDATE articles SET summary=? WHERE id=?",
      JSON.stringify({ ...originalSummary, reason: "Updated reason for agent." }),
      article.id,
    );
    await ai.translate(article.id);
    assert.equal(requests, 4);
    assert.equal(f.store.usage("2000-01-01").totals.requests, 4);
    assert.equal(
      f.store.get("SELECT count(*) n FROM ai_calls WHERE task='summary'").n,
      0,
    );
    assert.equal(
      f.store.get("SELECT count(*) n FROM ai_calls WHERE task='translation'").n,
      4,
    );
  } finally {
    f.done();
  }
});
test("translation uses the shared daily budget without consuming the automatic story limit", async () => {
  const f = fixture();
  try {
    f.config.update({ openaiKey: "test", dailyBudget: 0.01 });
    f.store.ingest([item(12)], localClock().day);
    const article = f.store.get("SELECT id FROM articles");
    f.store.run(
      "UPDATE articles SET summary=? WHERE id=?",
      JSON.stringify(summary),
      article.id,
    );
    const c = f.config.get();
    f.store.run(
      "INSERT INTO ai_calls(article_id,day,created_at,mode,task,model,status,reserved,prices,cost) VALUES(?,?,?,'auto','summary',?,'ok',?,?,0.0099)",
      article.id,
      localClock().day,
      new Date().toISOString(),
      c.model,
      0.0099,
      JSON.stringify(c.prices),
    );
    let requests = 0;
    const ai = new AI(f.store, f.config, async () => {
      requests++;
      return okFetch()();
    });
    await assert.rejects(ai.translate(article.id, "auto"), /ngân sách/);
    assert.equal(requests, 0);
    assert.equal(f.store.article(article.id).summary.recommendation, "xem");
    assert.equal(f.store.article(article.id).translation_status, "failed");
    assert.equal(
      f.store.get("SELECT count(*) n FROM ai_calls WHERE mode='auto' AND task='summary'").n,
      1,
    );
  } finally {
    f.done();
  }
});
test("invalid output still records billed usage; timeout remains unknown", async () => {
  const f = fixture();
  try {
    f.config.update({ openaiKey: "test" });
    f.store.ingest([item(1), item(2)], localClock().day);
    const articles = f.store.all("SELECT id FROM articles");
    const ai = new AI(
      f.store,
      f.config,
      async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            usage: { input_tokens: 100, output_tokens: 20 },
            output: [],
          }),
        ),
    );
    await assert.rejects(ai.summarize(articles[0].id));
    const row = f.store.get("SELECT * FROM ai_calls");
    assert.equal(row.status, "invalid_output");
    assert.ok(row.cost > 0);
    const ai2 = new AI(f.store, f.config, async () => {
      throw new Error("timeout");
    });
    await assert.rejects(ai2.summarize(articles[1].id));
    assert.equal(
      f.store.get("SELECT status FROM ai_calls ORDER BY id DESC LIMIT 1")
        .status,
      "unknown",
    );
    assert.equal(f.store.usage("2000-01-01").totals.unknown, 1);
  } finally {
    f.done();
  }
});
test("budget refuses call before network request", async () => {
  const f = fixture();
  try {
    f.config.update({ openaiKey: "test", dailyBudget: 0.000001 });
    f.store.ingest([item(1)], localClock().day);
    let calls = 0;
    const ai = new AI(f.store, f.config, async () => {
      calls++;
      return okFetch()();
    });
    await assert.rejects(
      ai.summarize(f.store.get("SELECT id FROM articles").id),
      /ngân sách/,
    );
    assert.equal(calls, 0);
  } finally {
    f.done();
  }
});
test("HTTP app rejects cross-origin mutation and host attacks, permits reading and changing article state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devpulse-http-"));
  const app = createApp({ dataDir: dir, environment: testEnvironment, disableSchedule: true });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  try {
    app.store.ingest([item(1)], localClock().day);
    let r = await fetch(base + "/api/state");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).settings.openaiKey, undefined);
    r = await fetch(base + "/api/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-DevPulse": "1",
        Origin: "https://attacker.example",
      },
      body: "{}",
    });
    assert.equal(r.status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      const req = http.get(
        base + "/api/state",
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
    });
    assert.equal(hostStatus, 403);
    const a = app.store.get("SELECT id FROM articles");
    r = await fetch(base + "/api/articles/" + a.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-DevPulse": "1" },
      body: JSON.stringify({ read: true, bookmarked: true }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).read, 1);
    r = await fetch(base + "/");
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("content-security-policy"));
    r = await fetch(base + "/data/settings.json");
    assert.equal(r.status, 404);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("translation API returns cached Vietnamese fields without changing source article data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devpulse-translation-http-"));
  const app = createApp({
    dataDir: dir,
    environment: testEnvironment,
    fetcher: okFetch(),
    disableSchedule: true,
  });
  app.config.update({ openaiKey: "test" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  try {
    app.store.ingest([item(20)], localClock().day);
    const article = app.store.get("SELECT id FROM articles");
    app.store.run("UPDATE articles SET summary=? WHERE id=?", JSON.stringify(summary), article.id);
    const beforeTranslation = await (await fetch(base + "/api/articles")).json();
    assert.equal(beforeTranslation.total, 0);
    const request = () =>
      fetch(base + "/api/articles/" + article.id + "/translation", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-DevPulse": "1" },
        body: "{}",
      });
    let response = await request();
    assert.equal(response.status, 200);
    let updated = await response.json();
    assert.equal(updated.translation_lang, "vi");
    assert.equal(updated.title, "GitHub Copilot agent 20");
    assert.deepEqual(updated.summary, summary);
    response = await fetch(base + "/api/articles");
    const list = await response.json();
    assert.equal(list.items[0].translation.title, updated.translation.title);
    response = await request();
    assert.equal(response.status, 200);
    assert.equal(
      app.store.get("SELECT count(*) n FROM ai_calls WHERE task='translation'").n,
      1,
    );
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
