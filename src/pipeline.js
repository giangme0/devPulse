import { collect } from "./sources.js";
import { isDue, localClock } from "./utils.js";
import { logger } from "./logger.js";
const aiConcurrency = 3;
export class Pipeline {
  constructor(store, config, ai, collector = collect) {
    Object.assign(this, { store, config, ai, collector });
    this.running = false;
    this.progress = "";
    this.lastRetry = 0;
  }
  async run(trigger = "manual") {
    if (this.running) throw new Error("Đang có một lượt cập nhật");
    this.running = true;
    const c = this.config.get(),
      day = localClock(new Date(), c.timezone).day;
    const id = Number(
      this.store.run(
        "INSERT INTO runs(day,trigger,started_at,status) VALUES(?,?,?,'running')",
        day,
        trigger,
        new Date().toISOString(),
      ).lastInsertRowid,
    );
    logger.info("pipeline.started", { runId: id, trigger, day });
    let details = {
      sources: [],
      inserted: 0,
      summarized: 0,
      aiErrors: [],
      aiSkipped: null,
    };
    try {
      this.progress = "Đang thu thập nguồn…";
      logger.info("pipeline.collect.started", { runId: id });
      const result = await this.collector(c);
      details.sources = result.sources;
      logger.info("pipeline.collect.completed", {
        runId: id,
        sources: result.sources,
        itemCount: result.items.length,
      });
      details.inserted = this.store.ingest(result.items, day);
      logger.info("pipeline.ingest.completed", {
        runId: id,
        received: result.items.length,
        inserted: details.inserted,
      });
      if (c.openaiKey) {
        const used = this.store.get(
          "SELECT count(*) n FROM ai_calls WHERE day=? AND mode='auto' AND task='summary'",
          day,
        ).n;
        const candidates = this.store.all(
          `SELECT id FROM articles WHERE saved_day=? AND summary IS NULL AND rank>=3 AND content<>'' AND id NOT IN (SELECT article_id FROM ai_calls WHERE day=? AND mode='auto' AND task='summary') ORDER BY rank + CASE WHEN EXISTS(SELECT 1 FROM articles a2 WHERE a2.category=articles.category AND a2.feedback='less') THEN -2 ELSE 0 END DESC,created_at DESC LIMIT ?`,
          day,
          day,
          Math.max(0, c.autoLimit - used),
        );
        logger.info("pipeline.ai.candidates", {
          runId: id,
          used,
          limit: c.autoLimit,
          count: candidates.length,
        });
        let nextCandidate = 0,
          stopScheduling = false;
        const processCandidate = async (a, index) => {
          this.progress = `Đang xử lý AI ${index + 1}/${candidates.length}…`;
          try {
            await this.ai.summarize(a.id, "auto");
            details.summarized++;
            await this.ai.translate(a.id, "auto");
            logger.info("pipeline.ai.completed", { runId: id, articleId: a.id });
          } catch (e) {
            details.aiErrors.push(e.message);
            logger.error("pipeline.ai.failed", {
              runId: id,
              articleId: a.id,
              error: e,
            });
            if (/HTTP 40[134]|HTTP 429|ngân sách|đơn giá/.test(e.message))
              stopScheduling = true;
          }
        };
        const worker = async () => {
          while (!stopScheduling) {
            const index = nextCandidate++;
            if (index >= candidates.length) return;
            await processCandidate(candidates[index], index);
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(aiConcurrency, candidates.length) },
            () => worker(),
          ),
        );
      } else
        details.aiSkipped = "Chưa có OpenAI API key; tin vẫn được lưu đầy đủ.";
      const allFail =
        result.sources.length === 0 || result.sources.every((x) => !x.ok);
      const partial =
        result.sources.some((x) => !x.ok) || details.aiErrors.length > 0;
      this.store.run(
        "UPDATE runs SET finished_at=?,status=?,details=? WHERE id=?",
        new Date().toISOString(),
        allFail ? "failed" : partial ? "partial" : "ok",
        JSON.stringify(details),
        id,
      );
      if (!allFail) this.store.meta("lastScheduledDay", day);
      this.lastRetry = Date.now();
      logger.info("pipeline.completed", {
        runId: id,
        status: allFail ? "failed" : partial ? "partial" : "ok",
        details,
      });
      return details;
    } catch (e) {
      logger.error("pipeline.failed", { runId: id, trigger, error: e });
      details.error = e.message;
      this.store.run(
        "UPDATE runs SET finished_at=?,status='failed',details=? WHERE id=?",
        new Date().toISOString(),
        JSON.stringify(details),
        id,
      );
      this.lastRetry = Date.now();
      throw e;
    } finally {
      this.running = false;
      this.progress = "";
    }
  }
  async tick(now = new Date()) {
    if (
      !this.running &&
      Date.now() - this.lastRetry > 30 * 60 * 1000 &&
      isDue(now, this.config.get(), this.store.meta("lastScheduledDay"))
    ) {
      try {
        await this.run("schedule");
      } catch (error) {
        logger.error("pipeline.schedule.failed", { error });
      }
    }
  }
  status() {
    return {
      running: this.running,
      progress: this.progress,
      activeAI: this.ai.active.size,
      lastRun: this.store.get("SELECT * FROM runs ORDER BY id DESC LIMIT 1"),
      runs: this.store.all("SELECT * FROM runs ORDER BY id DESC LIMIT 10"),
    };
  }
}
