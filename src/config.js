import fs from "node:fs";
import path from "node:path";
import { environment as defaultEnvironment } from "./environment.js";
export const DEFAULTS = {
  model: "gpt-4.1-mini",
  prices: { input: 0.4, cached: 0.1, output: 1.6 },
  priceModel: "gpt-4.1-mini",
  priceNote: "USD / 1M tokens; tham khảo OpenAI, kiểm tra lại trước khi dùng.",
  dailyBudget: 1,
  autoLimit: 10,
  scheduleEnabled: true,
  scheduleTime: "06:00",
  timezone: "Asia/Ho_Chi_Minh",
  sources: {
    githubCopilot: true,
    microsoft: true,
    huggingface: true,
    github: true,
    daily: false,
  },
  rssSources: [
    {
      id: "simonWillison",
      name: "Simon Willison",
      type: "atom",
      url: "https://simonwillison.net/atom/everything/",
      limit: 10,
      include_keywords: ["prompt", "agent", "claude", "llm", "openai", "eval"],
      include_categories: [],
      weight: 1.0,
      enabled: true,
    },
    {
      id: "openaiNews",
      name: "OpenAI News",
      type: "rss",
      url: "https://openai.com/news/rss.xml",
      limit: 8,
      include_keywords: [],
      include_categories: ["Product", "Research", "Engineering"],
      weight: 0.9,
      enabled: true,
    },
    {
      id: "huggingfaceBlog",
      name: "Hugging Face Blog",
      type: "rss",
      url: "https://huggingface.co/blog/feed.xml",
      limit: 8,
      include_keywords: [],
      include_categories: [],
      weight: 0.8,
      enabled: true,
    },
    {
      id: "lilianWeng",
      name: "Lilian Weng (Lil'Log)",
      type: "rss",
      url: "https://lilianweng.github.io/index.xml",
      limit: 3,
      include_keywords: [],
      include_categories: [],
      weight: 0.9,
      enabled: true,
    },
  ],
  dailyFeedUrl: "",
  profile:
    "AI Native trong phát triển software; tool hỗ trợ agent, MCP, context management, evaluation; ưu tiên Microsoft Copilot và GitHub Copilot; prompt engineering. Loại tin gọi vốn và quảng cáo chung chung.",
  openaiKey: "",
  githubToken: "",
};
export class Config {
  constructor(dir, { environment = defaultEnvironment, secretsEnabled = true } = {}) {
    this.environment = environment;
    this.secretsEnabled = secretsEnabled;
    this.file = path.join(dir, "settings.json");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.value = fs.existsSync(this.file)
      ? {
          ...structuredClone(DEFAULTS),
          ...JSON.parse(fs.readFileSync(this.file, "utf8")),
        }
      : structuredClone(DEFAULTS);
    if (fs.existsSync(this.file)) fs.chmodSync(this.file, 0o600);
  }
  get() {
    const v = structuredClone(this.value);
    v.openaiKey = this.secret("OPENAI_API_KEY", v.openaiKey).value;
    v.model = this.secret("OPENAI_MODEL", v.model).value;
    v.githubToken = this.secret("GITHUB_TOKEN", v.githubToken).value;
    return v;
  }
  secret(name, saved) {
    return this.secretsEnabled
      ? this.environment.secret(name, saved)
      : { value: "", source: "none" };
  }
  public() {
    const v = this.get();
    const hasOpenaiKey = !!v.openaiKey,
      hasGithubToken = !!v.githubToken;
    delete v.openaiKey;
    delete v.githubToken;
    return {
      ...v,
      hasOpenaiKey,
      hasGithubToken,
      openaiKeySource: this.secret("OPENAI_API_KEY", this.value.openaiKey).source,
      githubTokenSource: this.secret("GITHUB_TOKEN", this.value.githubToken).source,
      envOpenaiKey: ["system", "dotenv"].includes(this.secret("OPENAI_API_KEY").source),
      envGithubToken: ["system", "dotenv"].includes(this.secret("GITHUB_TOKEN").source),
    };
  }
  update(p) {
    const allowed = Object.keys(DEFAULTS);
    const n = { ...this.value };
    for (const [k, v] of Object.entries(p)) if (allowed.includes(k)) n[k] = v;
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(n.model))
      throw new Error("Model không hợp lệ");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(n.scheduleTime))
      throw new Error("Giờ phải có dạng HH:mm");
    try {
      new Intl.DateTimeFormat("en", { timeZone: n.timezone }).format();
    } catch {
      throw new Error("Timezone không hợp lệ");
    }
    if (
      typeof n.scheduleEnabled !== "boolean" ||
      !Number.isInteger(n.autoLimit) ||
      n.autoLimit < 1 ||
      n.autoLimit > 10
    )
      throw new Error("Hạn mức tự động từ 1 đến 10");
    if (
      typeof n.dailyBudget !== "number" ||
      !Number.isFinite(n.dailyBudget) ||
      n.dailyBudget <= 0 ||
      n.dailyBudget > 100
    )
      throw new Error("Ngân sách phải lớn hơn 0 và không quá 100 USD/ngày");
    if (
      typeof n.profile !== "string" ||
      !n.profile.trim() ||
      n.profile.length > 4000
    )
      throw new Error("Profile phải có 1–4000 ký tự");
    if (
      !n.sources ||
      Object.keys(DEFAULTS.sources).some(
        (k) => typeof n.sources[k] !== "boolean",
      )
    )
      throw new Error("Nguồn không hợp lệ");
    if (
      !Array.isArray(n.rssSources) ||
      n.rssSources.some(
        (source) =>
          !source ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(source.id) ||
          !["rss", "atom"].includes(source.type) ||
          typeof source.url !== "string" ||
          !Number.isInteger(source.limit) ||
          source.limit < 1 ||
          source.limit > 100 ||
          !Array.isArray(source.include_keywords) ||
          !source.include_keywords.every((value) => typeof value === "string") ||
          !Array.isArray(source.include_categories) ||
          !source.include_categories.every((value) => typeof value === "string") ||
          typeof source.weight !== "number" ||
          !Number.isFinite(source.weight) ||
          source.weight < 0 ||
          source.weight > 10 ||
          typeof source.enabled !== "boolean",
      ) ||
      new Set(n.rssSources.map((source) => source.id)).size !== n.rssSources.length
    )
      throw new Error("Cấu hình RSS/Atom không hợp lệ");
    for (const source of n.rssSources) {
      const url = new URL(source.url);
      if (url.protocol !== "https:" || url.username || url.password || url.port)
        throw new Error("RSS/Atom chỉ nhận URL HTTPS hợp lệ");
    }
    for (const k of ["openaiKey", "githubToken"])
      if (typeof n[k] !== "string" || n[k].length > 1000 || /[\r\n]/.test(n[k]))
        throw new Error("Key không hợp lệ");
    if (typeof n.dailyFeedUrl !== "string")
      throw new Error("RSS URL không hợp lệ");
    if (n.dailyFeedUrl) {
      const u = new URL(n.dailyFeedUrl);
      if (
        u.protocol !== "https:" ||
        !["rss-app.daily.dev", "daily.dev"].includes(u.hostname) ||
        u.username ||
        u.password ||
        u.port
      )
        throw new Error(
          "Chỉ nhận HTTPS RSS từ rss-app.daily.dev hoặc daily.dev",
        );
    }
    if (n.sources.daily && !n.dailyFeedUrl)
      throw new Error("Hãy nhập URL RSS daily.dev");
    if (n.model !== this.value.model && !p.prices) {
      n.prices = null;
      n.priceModel = n.model;
    }
    if (
      n.prices !== null &&
      (!n.prices ||
        ["input", "cached", "output"].some(
          (k) =>
            typeof n.prices[k] !== "number" ||
            !Number.isFinite(n.prices[k]) ||
            n.prices[k] < 0 ||
            n.prices[k] > 10000,
        ))
    )
      throw new Error("Đơn giá không hợp lệ");
    n.priceModel = n.model;
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(n, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(this.file + ".tmp", this.file);
    this.value = n;
    return this.public();
  }
}
