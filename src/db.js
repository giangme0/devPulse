import { DatabaseSync } from "node:sqlite";
import { canonicalUrl, hash, classify } from "./utils.js";
export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS articles(id TEXT PRIMARY KEY,url TEXT UNIQUE NOT NULL,title TEXT NOT NULL,source TEXT NOT NULL,content TEXT NOT NULL,metadata TEXT NOT NULL,published_at TEXT,saved_day TEXT NOT NULL,created_at TEXT NOT NULL,category TEXT NOT NULL,rank REAL NOT NULL,read INTEGER NOT NULL DEFAULT 0,bookmarked INTEGER NOT NULL DEFAULT 0,feedback TEXT,summary TEXT,summary_model TEXT,summary_at TEXT,recommended INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS articles_day ON articles(saved_day);
 CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY,day TEXT NOT NULL,trigger TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL,details TEXT NOT NULL DEFAULT '{}');
 CREATE TABLE IF NOT EXISTS ai_calls(id INTEGER PRIMARY KEY,article_id TEXT,day TEXT NOT NULL,created_at TEXT NOT NULL,mode TEXT NOT NULL,task TEXT NOT NULL DEFAULT 'summary',model TEXT NOT NULL,status TEXT NOT NULL,input_tokens INTEGER, cached_tokens INTEGER,output_tokens INTEGER,cost REAL,reserved REAL NOT NULL,prices TEXT NOT NULL,error TEXT,response_id TEXT);
 CREATE TABLE IF NOT EXISTS article_translations(article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,lang TEXT NOT NULL,content_hash TEXT NOT NULL,prompt_version TEXT NOT NULL,model TEXT NOT NULL,translated_at TEXT,status TEXT NOT NULL,value TEXT,error TEXT,PRIMARY KEY(article_id,lang));
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 PRAGMA user_version=1;`);
    if (
      !this.all("PRAGMA table_info(ai_calls)").some((column) => column.name === "task")
    )
      this.db.exec("ALTER TABLE ai_calls ADD COLUMN task TEXT NOT NULL DEFAULT 'summary'");
    this.db
      .prepare(
        "UPDATE runs SET status='interrupted', finished_at=? WHERE status='running'",
      )
      .run(new Date().toISOString());
    this.db
      .prepare(
        "UPDATE ai_calls SET status='unknown',error='Ứng dụng dừng giữa request; chi phí chưa xác định' WHERE status='pending'",
      )
      .run();
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  meta(k, v) {
    if (v !== undefined)
      this.run(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        k,
        String(v),
      );
    return this.get("SELECT value FROM meta WHERE key=?", k)?.value;
  }
  ingest(items, day) {
    let inserted = 0;
    this.db.exec("BEGIN");
    try {
      for (const a of items) {
        if (!a.title || !a.url) continue;
        let url;
        try {
          url = canonicalUrl(a.url);
        } catch {
          continue;
        }
        const { category, rank } = classify(a.title, a.content);
        const metadata = { ...(a.metadata || {}) };
        const weightedRank = rank * (metadata.source_weight ?? 1);
        const id = hash(url);
        const result = this.run(
          "INSERT OR IGNORE INTO articles(id,url,title,source,content,metadata,published_at,saved_day,created_at,category,rank) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          id,
          url,
          String(a.title).slice(0, 600),
          a.source,
          String(a.content || "").slice(0, 24000),
          JSON.stringify(metadata),
          a.published_at || null,
          day,
          new Date().toISOString(),
          category,
          weightedRank,
        );
        inserted += Number(result.changes);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return inserted;
  }
  article(id) {
    const a = this.get("SELECT * FROM articles WHERE id=?", id);
    if (!a) return null;
    const article = {
      ...a,
      summary: a.summary ? JSON.parse(a.summary) : null,
      metadata: JSON.parse(a.metadata),
      ...this.translation(id),
    };
    return { ...article, ai_status: this.aiStatus(article) };
  }
  aiStatus(article) {
    if (article.translation_status === "ok" && article.translation) return "ready";
    if (article.translation_status === "pending") return "processing";
    if (article.translation_status === "failed") return "failed";
    if (article.summary) return "waiting";
    const call = this.get(
      "SELECT status FROM ai_calls WHERE article_id=? AND task='summary' ORDER BY id DESC LIMIT 1",
      article.id,
    );
    if (call?.status === "pending") return "processing";
    if (["http_error", "invalid_output", "unknown"].includes(call?.status))
      return "failed";
    return "waiting";
  }
  translation(articleId) {
    const row = this.get(
      "SELECT lang,prompt_version,model,translated_at,status,value,error FROM article_translations WHERE article_id=? AND lang='vi'",
      articleId,
    );
    return {
      translation: row?.status === "ok" && row.value ? JSON.parse(row.value) : null,
      translation_lang: row?.lang || null,
      translation_prompt_version: row?.prompt_version || null,
      translation_model: row?.model || null,
      translation_at: row?.translated_at || null,
      translation_status: row?.status || null,
      translation_error: row?.error || null,
    };
  }
  dates() {
    return this.all(
      "SELECT saved_day AS day,count(*) AS total,sum(read=0) AS unread FROM articles GROUP BY saved_day ORDER BY saved_day DESC",
    );
  }
  list({
    day,
    read = "all",
    category = "",
    saved = false,
    q = "",
    recommended = false,
    summaryStatus = "ready",
    offset = 0,
  }) {
    let where = [],
      params = [];
    if (day) {
      where.push("saved_day=?");
      params.push(day);
    }
    if (["0", "1"].includes(read)) {
      where.push("read=?");
      params.push(Number(read));
    }
    if (category) {
      where.push("category=?");
      params.push(category);
    }
    if (saved) where.push("bookmarked=1");
    if (recommended) where.push("recommended=1");
    if (summaryStatus === "ready")
      where.push("t.status='ok' AND t.value IS NOT NULL");
    if (summaryStatus === "missing")
      where.push("(t.status IS NULL OR t.status<>'ok' OR t.value IS NULL)");
    if (q) {
      where.push("(title LIKE ? OR content LIKE ?)");
      params.push("%" + q + "%", "%" + q + "%");
    }
    const from =
      " FROM articles LEFT JOIN article_translations t ON t.article_id=articles.id AND t.lang='vi'";
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const counts = this.get(
      "SELECT count(*) AS total,COALESCE(sum(articles.read=0),0) AS unread" + from + clause,
      ...params,
    );
    const items = this.all(
      `SELECT articles.id,articles.title,url,source,saved_day,published_at,category,rank,read,bookmarked,feedback,recommended,summary,t.value AS translation,t.status AS translation_status,t.error AS translation_error,CASE WHEN t.status='ok' AND t.value IS NOT NULL THEN 'ready' WHEN t.status='pending' THEN 'processing' WHEN t.status='failed' THEN 'failed' WHEN articles.summary IS NOT NULL THEN 'waiting' WHEN (SELECT status FROM ai_calls WHERE article_id=articles.id AND task='summary' ORDER BY id DESC LIMIT 1)='pending' THEN 'processing' WHEN (SELECT status FROM ai_calls WHERE article_id=articles.id AND task='summary' ORDER BY id DESC LIMIT 1) IN ('http_error','invalid_output','unknown') THEN 'failed' ELSE 'waiting' END AS ai_status${from}${clause} ORDER BY recommended DESC,rank DESC,created_at DESC,id LIMIT 50 OFFSET ?`,
      ...params,
      offset,
    ).map((a) => ({
      ...a,
      summary: a.summary ? JSON.parse(a.summary) : null,
      translation:
        a.translation_status === "ok" && a.translation
          ? JSON.parse(a.translation)
          : null,
    }));
    return { total: counts.total, unread: counts.unread, items };
  }
  usage(since) {
    const rows = this.all(
      `SELECT day,model,task,count(*) requests,sum(COALESCE(input_tokens,0)) input_tokens,sum(COALESCE(cached_tokens,0)) cached_tokens,sum(COALESCE(output_tokens,0)) output_tokens,sum(COALESCE(cost,0)) cost,sum(cost IS NULL) unknown FROM ai_calls WHERE day>=? GROUP BY day,model,task ORDER BY day DESC,model,task`,
      since,
    );
    const totals = rows.reduce(
      (a, r) => {
        for (const k of [
          "requests",
          "input_tokens",
          "cached_tokens",
          "output_tokens",
          "cost",
          "unknown",
        ])
          a[k] += r[k];
        return a;
      },
      {
        requests: 0,
        input_tokens: 0,
        cached_tokens: 0,
        output_tokens: 0,
        cost: 0,
        unknown: 0,
      },
    );
    return {
      rows,
      totals,
      recent: this.all(
        "SELECT created_at,model,task,status,error,cost FROM ai_calls WHERE day>=? ORDER BY id DESC LIMIT 20",
        since,
      ),
    };
  }
  close() {
    this.db.close();
  }
}
