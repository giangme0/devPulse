import { XMLParser, XMLValidator } from "fast-xml-parser";
import { plain } from "./utils.js";
import { logger } from "./logger.js";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
});
const array = (x) => (x ? (Array.isArray(x) ? x : [x]) : []);
const str = (x) => (typeof x === "object" ? x?.["#text"] || "" : x || "");
const labels = (value) =>
  array(value)
    .map((item) =>
      typeof item === "object" ? item["@_term"] || str(item) : String(item),
    )
    .filter(Boolean);
export function parseFeed(xml, source, limit = Infinity) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")))
    throw new Error("Feed chứa DTD không được hỗ trợ");
  if (XMLValidator.validate(xml) !== true)
    throw new Error("RSS/Atom không hợp lệ");
  const p = parser.parse(xml);
  if (!p.rss && !p.feed && !p["rdf:RDF"])
    throw new Error("Nguồn không phải RSS/Atom");
  return array(p.rss?.channel?.item || p.feed?.entry || p["rdf:RDF"]?.item)
    .slice(0, limit)
    .map((a) => {
      const tags = [...labels(a.category), ...labels(a.tag)];
      const content =
        str(a["content:encoded"]) ||
        str(a.content) ||
        str(a.description) ||
        str(a.summary);
      return {
      title: plain(str(a.title)),
      url:
        typeof a.link === "string"
          ? a.link
          : array(a.link).find(
              (l) => !l["@_rel"] || l["@_rel"] === "alternate",
            )?.["@_href"] || str(a.guid),
      content: plain(plain(content)),
      published_at:
        str(a.pubDate) || str(a.published) || str(a.updated) || null,
      source,
      tags,
      metadata: { basis: "RSS/Atom excerpt", tags },
      };
    });
}
export async function fetchText(url, headers = {}, fetcher = fetch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const options = {
        method: "GET",
        headers: {
          "User-Agent": "DevPulse-Local/1.0",
          Accept:
            "application/json, application/rss+xml, application/atom+xml, text/xml",
          ...headers,
        },
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      };
      logger.debug("api.request", {
        url,
        method: options.method,
        params: Object.fromEntries(new URL(url).searchParams),
        headers: options.headers,
        attempt: attempt + 1,
      });
      const r = await fetcher(url, options);
      let size = 0;
      const chunks = [];
      for await (const chunk of r.body) {
        size += chunk.length;
        if (size > 3e6) throw new Error("Phản hồi nguồn vượt 3 MB");
        chunks.push(chunk);
      }
      const response = Buffer.concat(chunks).toString("utf8");
      logger.info("api.response", {
        url,
        method: options.method,
        status: r.status,
        response,
        attempt: attempt + 1,
      });
      if (!r.ok) {
        if ((r.status === 429 || r.status >= 500) && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        throw new Error(`HTTP ${r.status}`);
      }
      return response;
    } catch (e) {
      logger.error("api.exception", {
        url,
        method: "GET",
        attempt: attempt + 1,
        error: e,
      });
      if (attempt === 0 && ["TimeoutError", "TypeError"].includes(e.name))
        continue;
      throw new Error(
        e.message.startsWith("HTTP")
          ? e.message
          : "Không tải được nguồn (timeout, redirect hoặc định dạng)",
      );
    }
  }
}
export async function collect(config, fetcher = fetch) {
  const requests = [];
  const rss = (id, name, url) =>
    requests.push({
      id,
      name,
      load: async () =>
        parseFeed(await fetchText(url, {}, fetcher), name).slice(0, 6),
    });
  if (config.sources.githubCopilot)
    rss(
      "githubCopilot",
      "GitHub Copilot",
      "https://github.blog/changelog/label/copilot/feed/",
    );
  if (config.sources.microsoft)
    rss("microsoft", "Microsoft Blog", "https://blogs.microsoft.com/feed/");
  if (config.sources.daily) rss("daily", "daily.dev", config.dailyFeedUrl);
  if (config.sources.huggingface)
    requests.push({
      id: "huggingface",
      name: "Hugging Face Papers",
      load: async () => {
        const list = JSON.parse(
          await fetchText(
            "https://huggingface.co/api/daily_papers",
            {},
            fetcher,
          ),
        );
        if (!Array.isArray(list)) throw new Error("Papers schema đã thay đổi");
        return list
          .sort((a, b) => (b.paper?.upvotes || 0) - (a.paper?.upvotes || 0))
          .slice(0, 6)
          .map((x) => ({
            title: x.title || x.paper?.title,
            url: `https://huggingface.co/papers/${x.paper?.id}`,
            content: x.summary || x.paper?.summary || "",
            published_at: x.publishedAt || x.paper?.publishedAt,
            source: "Hugging Face Papers",
            metadata: {
              basis: "paper abstract",
              paper_id: x.paper?.id,
              upvotes: x.paper?.upvotes,
            },
          }));
      },
    });
  if (config.sources.github)
    requests.push({
      id: "github",
      name: "GitHub Search",
      load: async () => {
        const date = new Date(Date.now() - 30 * 864e5)
          .toISOString()
          .slice(0, 10);
        const headers = config.githubToken
          ? { Authorization: `Bearer ${config.githubToken}` }
          : {};
        const all = [];
        for (const lang of ["Python", "TypeScript"]) {
          const q = `topic:ai-agent language:${lang} created:>=${date} archived:false`;
          const p = JSON.parse(
            await fetchText(
              `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=3`,
              headers,
              fetcher,
            ),
          );
          if (!Array.isArray(p.items))
            throw new Error("GitHub schema đã thay đổi");
          all.push(
            ...p.items.map((x) => ({
              title: x.full_name,
              url: x.html_url,
              content: x.description || "",
              published_at: x.created_at,
              source: "GitHub Search",
              metadata: {
                basis: "repository description only",
                repo_id: x.id,
                language: x.language,
                stars: x.stargazers_count,
                license: x.license?.spdx_id || null,
              },
            })),
          );
        }
        return all;
      },
    });
  for (const source of config.rssSources || []) {
    if (!source.enabled) continue;
    const name = source.name || source.id;
    requests.push({
      id: source.id,
      name,
      load: async () => {
        const items = parseFeed(
          await fetchText(source.url, {}, fetcher),
          name,
          source.limit,
        );
        const keywords = source.include_keywords.map((value) =>
          value.toLocaleLowerCase(),
        );
        const categories = source.include_categories.map((value) =>
          value.toLocaleLowerCase(),
        );
        return items
          .filter((item) => {
            const searchable = [item.title, item.content, ...item.tags]
              .join(" ")
              .toLocaleLowerCase();
            const categoryMatch = item.tags.some((tag) =>
              categories.includes(tag.toLocaleLowerCase()),
            );
            return (
              (!keywords.length ||
                keywords.some((keyword) => searchable.includes(keyword))) &&
              (!categories.length || categoryMatch)
            );
          })
          .map((item) => ({
            ...item,
            metadata: {
              ...item.metadata,
              source_weight: source.weight,
            },
          }));
      },
    });
  }
  const out = await Promise.allSettled(requests.map((x) => x.load()));
  out.forEach((result, index) => {
    logger[result.status === "fulfilled" ? "info" : "error"](
      result.status === "fulfilled" ? "source.completed" : "source.failed",
      {
        id: requests[index].id,
        name: requests[index].name,
        count: result.status === "fulfilled" ? result.value.length : 0,
        error: result.status === "rejected" ? result.reason : undefined,
      },
    );
  });
  return {
    items: out.flatMap((x) => (x.status === "fulfilled" ? x.value : [])),
    sources: out.map((x, i) => ({
      id: requests[i].id,
      name: requests[i].name,
      ok: x.status === "fulfilled",
      count: x.status === "fulfilled" ? x.value.length : 0,
      error: x.status === "rejected" ? x.reason.message : null,
    })),
  };
}
