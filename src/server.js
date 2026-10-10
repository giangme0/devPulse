import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "./config.js";
import { Store } from "./db.js";
import { AI } from "./ai.js";
import { Pipeline } from "./pipeline.js";
import { localClock, categories } from "./utils.js";
import { environment as defaultEnvironment, prepareDataDir, root } from "./environment.js";
import { logger } from "./logger.js";
export function createApp({
  dataDir,
  environment = defaultEnvironment,
  secretsEnabled = true,
  fetcher = fetch,
  collector,
  disableSchedule = false,
} = {}) {
  process.umask(0o077);
  const runtime = environment.runtime();
  dataDir = path.resolve(root, dataDir ?? runtime.dataDir);
  prepareDataDir(dataDir);
  let config, store;
  try {
    config = new Config(dataDir, { environment, secretsEnabled });
  } catch {
    throw new Error("Không thể đọc cấu hình settings.json; kiểm tra nội dung và quyền truy cập");
  }
  try {
    store = new Store(path.join(dataDir, "devpulse.db"));
  } catch {
    throw new Error("Không thể mở database trong thư mục dữ liệu; kiểm tra quyền truy cập và database");
  }
  const ai = new AI(store, config, fetcher),
    pipeline = new Pipeline(store, config, ai, collector);
  const automaticStatus = () => {
    const settings = config.get();
    if (!settings.openaiKey) return "missing_key";
    if (!settings.prices) return "missing_pricing";
    const day = localClock(new Date(), settings.timezone).day;
    const used = store.get(
      "SELECT count(*) n FROM ai_calls WHERE day=? AND mode='auto' AND task='summary'",
      day,
    ).n;
    if (used >= settings.autoLimit) return "daily_limit";
    const spent = store.get(
      "SELECT COALESCE(sum(COALESCE(cost,reserved)),0) n FROM ai_calls WHERE day=?",
      day,
    ).n;
    return spent >= settings.dailyBudget ? "budget" : "available";
  };
  const withAiStatus = (article) => {
    if (!article || article.ai_status !== "waiting") return article;
    const status = automaticStatus();
    return status === "available" ? article : { ...article, ai_status: status };
  };
  const json = (res, code, obj) => {
    if (res.logContext)
      logger.info("http.response", {
        ...res.logContext,
        status: code,
        durationMs: Math.round(performance.now() - res.logStartedAt),
        response: obj,
      });
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(obj));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      const port = server.address()?.port;
      const url = new URL(req.url, "http://localhost"),
        route = url.pathname;
      if (route.startsWith("/api/")) {
        res.logStartedAt = performance.now();
        res.logContext = {
          method: req.method,
          url: `http://localhost:${port}${url.pathname}${url.search}`,
        };
        logger.debug("http.request.started", {
          ...res.logContext,
          params: { query: Object.fromEntries(url.searchParams) },
        });
      }
      const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
      if (!hosts.includes(req.headers.host))
        return json(res, 403, { error: "Host không được phép" });
      if (
        req.headers.origin &&
        !hosts.map((x) => "http://" + x).includes(req.headers.origin)
      )
        return json(res, 403, { error: "Origin không được phép" });
      if (route.startsWith("/api/")) {
        let body = {};
        if (["POST", "PATCH", "PUT"].includes(req.method)) {
          if (
            req.headers["x-devpulse"] !== "1" ||
            !req.headers["content-type"]?.startsWith("application/json")
          )
            return json(res, 403, { error: "Yêu cầu thiếu header bảo vệ" });
          let raw = "";
          for await (const chunk of req) {
            raw += chunk;
            if (Buffer.byteLength(raw) > 24000)
              return json(res, 413, { error: "Payload quá lớn" });
          }
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            return json(res, 400, { error: "JSON không hợp lệ" });
          }
          if (!body || typeof body !== "object" || Array.isArray(body))
            throw new Error("Payload không hợp lệ");
        }
        logger.debug("http.request", {
          ...res.logContext,
          params: { query: Object.fromEntries(url.searchParams), body },
        });
        if (req.method === "GET" && route === "/api/state")
          return json(res, 200, {
            ...pipeline.status(),
            aiStatus: automaticStatus(),
            today: localClock(new Date(), config.get().timezone).day,
            dates: store.dates(),
            settings: config.public(),
          });
        if (req.method === "GET" && route === "/api/articles") {
          const p = url.searchParams,
            offset = Number(p.get("offset") || 0);
          if (!Number.isInteger(offset) || offset < 0)
            throw new Error("Offset không hợp lệ");
          return json(
            res,
            200,
            (() => {
              const result = store.list({
                day: p.get("day") || "",
                read: p.get("read") || "all",
                category: p.get("category") || "",
                saved: p.get("saved") === "1",
                recommended: p.get("recommended") === "1",
                summaryStatus: p.get("summary") === "missing" ? "missing" : "ready",
                q: (p.get("q") || "").slice(0, 200),
                offset,
              });
              return { ...result, items: result.items.map(withAiStatus) };
            })(),
          );
        }
        if (req.method === "POST" && route === "/api/refresh") {
          if (pipeline.running)
            return json(res, 409, { error: "Đang cập nhật" });
          pipeline.run("manual").catch(() => {});
          return json(res, 202, { ok: true });
        }
        if (req.method === "PUT" && route === "/api/settings") {
          if (pipeline.running || ai.active.size)
            return json(res, 409, {
              error: "Đợi lượt xử lý hiện tại hoàn tất rồi đổi cấu hình",
            });
          return json(res, 200, config.update(body));
        }
        if (req.method === "GET" && route === "/api/usage") {
          const days = Number(url.searchParams.get("days") || 7);
          if (![1, 7, 30, 36500].includes(days))
            throw new Error("Khoảng ngày không hợp lệ");
          const today = localClock(new Date(), config.get().timezone).day;
          const since = new Date(
            Date.parse(today + "T12:00:00Z") - (days - 1) * 864e5,
          )
            .toISOString()
            .slice(0, 10);
          return json(res, 200, store.usage(since));
        }
        const match = route.match(
          /^\/api\/articles\/([a-f0-9]{64})(?:\/(summary|translation))?$/,
        );
        if (match) {
          const a = store.article(match[1]);
          if (!a) return json(res, 404, { error: "Không tìm thấy tin" });
          if (req.method === "GET" && !match[2]) return json(res, 200, withAiStatus(a));
          if (req.method === "POST" && match[2]) {
            if (pipeline.running || ai.active.size)
              return json(res, 409, {
                error: "AI đang bận; vui lòng đợi lượt hiện tại hoàn tất",
              });
            if (match[2] === "summary") {
              await ai.summarize(a.id);
              await ai.translate(a.id).catch((error) =>
                logger.error("ai.translation.failed", {
                  articleId: a.id,
                  error,
                }),
              );
            } else await ai.translate(a.id);
            return json(res, 200, withAiStatus(store.article(a.id)));
          }
          if (req.method === "PATCH" && !match[2]) {
            for (const k of ["read", "bookmarked"])
              if (body[k] !== undefined) {
                if (typeof body[k] !== "boolean")
                  throw new Error("Trạng thái không hợp lệ");
                store.run(
                  `UPDATE articles SET ${k}=? WHERE id=?`,
                  Number(body[k]),
                  a.id,
                );
              }
            if (body.feedback !== undefined) {
              if (!["useful", "less", ""].includes(body.feedback))
                throw new Error("Phản hồi không hợp lệ");
              store.run(
                "UPDATE articles SET feedback=? WHERE id=?",
                body.feedback,
                a.id,
              );
            }
            return json(res, 200, withAiStatus(store.article(a.id)));
          }
        }
        return json(res, 404, { error: "API không tồn tại" });
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        return json(res, 405, { error: "Method không hỗ trợ" });
      const files = {
        "/": "index.html",
        "/app.js": "app.js",
        "/styles.css": "styles.css",
        "/favicon.svg": "favicon.svg",
      };
      if (!files[route]) return json(res, 404, { error: "Không tìm thấy" });
      const file = files[route],
        types = {
          html: "text/html",
          js: "text/javascript",
          css: "text/css",
          svg: "image/svg+xml",
        };
      res.writeHead(200, {
        "Content-Type": types[file.split(".").at(-1)] + "; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(path.join(root, "public", file)).pipe(res);
    } catch (e) {
      logger.error("http.exception", {
        method: req.method,
        url: req.url,
        error: e,
      });
      json(res, 400, {
        error: e.message.startsWith("SQLITE")
          ? "Lỗi database; xem log service"
          : e.message,
      });
    }
  });
  let timer;
  server.on("listening", () => {
    if (!disableSchedule) {
      timer = setInterval(() => pipeline.tick(), 30000);
      timer.unref();
      pipeline.tick();
    }
  });
  return {
    port: runtime.port,
    server,
    store,
    config,
    ai,
    pipeline,
    close: async () => {
      clearInterval(timer);
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let app;
  try {
    app = createApp();
  } catch (error) {
    logger.error("server.startup.failed", { error });
    console.error(error.message);
    process.exit(1);
  }
  const port = app.port;
  app.server.on("error", (e) => {
    logger.error("server.error", { error: e });
    console.error(
      e.code === "EADDRINUSE"
        ? "Cổng đang được sử dụng. Có thể service DevPulse đã chạy."
        : "Không thể khởi động HTTP server; kiểm tra cổng và quyền truy cập.",
    );
    process.exit(1);
  });
  app.server.listen(port, "127.0.0.1", () =>
    logger.info("server.started", {
      url: `http://localhost:${port}`,
      scheduler: true,
    }),
  );
  const stop = () => {
    logger.info("server.shutdown.started");
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
