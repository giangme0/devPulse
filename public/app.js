const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const state = {
  day: "",
  read: "all",
  category: "",
  saved: false,
  q: "",
  recommended: false,
  selected: null,
  previewMode: "summary",
  items: [],
  offset: 0,
  total: 0,
  server: null,
  listVersion: 0,
  detailVersion: 0,
};
const labels = [
  "Tất cả",
  "Copilot",
  "AI Native",
  "Agent tools",
  "Prompt engineering",
];
const e = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
function button(text, fn, cls = "") {
  const b = e("button", cls, text);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}
async function api(url, method = "GET", body) {
  const r = await fetch("/api" + url, {
    method,
    headers: body
      ? { "Content-Type": "application/json", "X-DevPulse": "1" }
      : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
let toastTimer;
function toast(t) {
  $("#toast").textContent = t;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 5000);
}
const safe =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      toast(err.message);
    }
  };
const formatDay = (d) => (d ? d.split("-").reverse().join("/") : "—");
const money = (n) => "$" + Number(n).toFixed(4);
const num = (n) => Number(n || 0).toLocaleString("vi-VN");
function renderDates() {
  const dates = state.server.dates;
  $("#date-list").replaceChildren(
    ...dates.slice(0, 60).map((d) => {
      const b = button(
        "",
        () => chooseDay(d.day),
        d.day === state.day ? "active" : "",
      );
      b.append(
        e("span", "", formatDay(d.day)),
        e("span", "", `${d.total} tin`),
      );
      return b;
    }),
  );
  $("#day-picker").value = state.day;
  const [year, month, day] = state.day.split("-").map(Number);
  const cal = $("#calendar");
  cal.replaceChildren(
    ...["T2", "T3", "T4", "T5", "T6", "T7", "CN"].map((x) =>
      e("span", "weekday", x),
    ),
  );
  const start = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  for (let i = 0; i < start; i++) cal.append(e("span"));
  for (let i = 1; i <= new Date(year, month, 0).getDate(); i++) {
    const d = `${year}-${String(month).padStart(2, "0")}-${String(i).padStart(2, "0")}`;
    const b = button(
      String(i),
      () => chooseDay(d),
      i === day ? "selected" : dates.some((x) => x.day === d) ? "has-news" : "",
    );
    b.setAttribute("aria-label", formatDay(d));
    cal.append(b);
  }
}
async function loadState() {
  state.server = await api("/state");
  if (!state.day) state.day = state.server.today;
  renderDates();
  const s = state.server,
    last = s.lastRun;
  $("#refresh").disabled = s.running;
  $("#refresh").textContent = s.running
    ? "↻ Đang cập nhật…"
    : "↻ Cập nhật ngay";
  $("#run-status").textContent = s.running
    ? s.progress
    : last
      ? `Lần gần nhất: ${new Date(last.started_at).toLocaleString("vi-VN")} · ${last.status}`
      : `Lịch: ${s.settings.scheduleTime} · ${s.settings.timezone}`;
  const notice = $("#notice");
  if (!s.settings.hasOpenaiKey) {
    notice.hidden = false;
    notice.className = "notice";
    notice.textContent =
      "Chưa có OpenAI API key. Mở Cài đặt để bật tóm tắt AI. App vẫn có thể thu thập và lưu tin.";
  } else if (
    last &&
    ["failed", "partial", "interrupted"].includes(last.status)
  ) {
    notice.hidden = false;
    notice.className = "notice error";
    notice.textContent =
      "Lượt cập nhật gần nhất có lỗi hoặc bị gián đoạn. Bấm Lịch sử cập nhật để xem chi tiết.";
  } else notice.hidden = true;
}
async function chooseDay(day) {
  state.day = day;
  state.saved = false;
  state.selected = null;
  state.previewMode = "summary";
  state.offset = 0;
  $("#nav-news").classList.add("active");
  $("#nav-saved").classList.remove("active");
  renderDates();
  await loadList();
  renderPreview(null);
}
function query() {
  const p = new URLSearchParams({
    read: state.read,
    category: state.category,
    saved: state.saved ? "1" : "0",
    q: state.q,
    recommended: state.recommended ? "1" : "0",
    summary: "ready",
    offset: String(state.offset),
  });
  if (!state.saved) p.set("day", state.day);
  return "/articles?" + p;
}
async function loadList(append = false) {
  const version = ++state.listVersion;
  const result = await api(query());
  if (version !== state.listVersion) return;
  state.total = result.total;
  state.unread = result.unread;
  state.items = append ? [...state.items, ...result.items] : result.items;
  renderList();
}
function renderList() {
  $("#page-title").textContent = state.saved
    ? "Đã lưu đọc sau"
    : `Bản tin ngày ${formatDay(state.day)}`;
  $("#counts").textContent = state.saved
    ? `${state.total} tin đã đánh dấu · tất cả ngày`
    : `${state.total} tin đã tóm tắt · ${state.unread || 0} chưa đọc · ${state.total - (state.unread || 0)} đã đọc`;
  const list = $("#article-list");
  list.replaceChildren();
  if (!state.items.length) {
    const empty = e("div", "empty");
    const message = state.server.running
      ? aiStatusText("processing")
      : ["failed", "partial", "interrupted"].includes(state.server.lastRun?.status)
        ? "Lượt xử lý gần nhất lỗi; chưa có bản tóm tắt hoàn chỉnh phù hợp."
        : state.server.aiStatus === "available"
          ? "Chưa có bản tóm tắt hoàn chỉnh phù hợp với bộ lọc hiện tại."
          : aiStatusText(state.server.aiStatus);
    empty.append(
      e("div", "empty-icon", "▤"),
      e("h2", "", "Chưa có tin trong mục này"),
      e("p", "", message),
    );
    list.append(empty);
  }
  for (const a of state.items) {
    const title = a.translation?.title || a.title;
    const b = button(
      "",
      safe(() => selectArticle(a.id)),
      `article${a.id === state.selected ? " selected" : ""}`,
    );
    b.setAttribute("aria-label", title);
    const icon = e(
      "span",
      "source-icon",
      a.source.includes("GitHub")
        ? "GH"
        : a.source.includes("Microsoft")
          ? "MS"
          : a.source.includes("Hugging")
            ? "HF"
              : a.source.includes("OpenAI")
                ? "OA"
                : a.source.includes("Simon")
                  ? "SW"
                  : a.source.includes("Lilian")
                    ? "LW"
                    : "DD",
    );
    if (!a.read) icon.append(e("span", "unread-dot"));
    const t = e("div", "article-text");
    t.append(e("h3", "", title));
    const meta = e("div", "meta", `${a.source} · ${a.category}`);
    if (a.recommended) meta.append(e("span", "tiny-badge", "★ Đáng xem"));
    if (a.bookmarked) meta.append(e("span", "tiny-badge", "☆"));
    t.append(
      meta,
      e(
        "p",
        "",
        a.translation?.reason || a.summary?.reason || aiStatusText(a.ai_status),
      ),
    );
    b.append(icon, t);
    list.append(b);
  }
  $("#load-more").hidden = state.items.length >= state.total;
}
async function selectArticle(id) {
  const version = ++state.detailVersion;
  state.selected = id;
  state.previewMode = "summary";
  renderList();
  const a = await api("/articles/" + id);
  if (version !== state.detailVersion) return;
  renderPreview(a);
  if (!a.read) {
    try {
      const updated = await api("/articles/" + id, "PATCH", { read: true });
      if (version !== state.detailVersion) return;
      renderPreview(updated);
      await loadList();
    } catch (err) {
      toast(err.message);
    }
  }
  if (innerWidth < 800)
    $("#preview").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderPreview(a) {
  const panel = $("#preview");
  panel.replaceChildren();
  if (!a) {
    const empty = e("div", "empty");
    empty.append(
      e("div", "empty-icon", "▤"),
      e("h2", "", "Chọn một tin để đọc"),
      e("p", "", "Điểm chính và điều kiện áp dụng được trình bày tại đây."),
    );
    panel.append(empty);
    return;
  }
  const original = state.previewMode === "original";
  panel.append(
    e(
      "span",
      "badge",
      original
        ? a.metadata?.basis
          ? "Trích đoạn nguồn"
          : "Nội dung gốc đã lưu"
        : "Bản tóm tắt tiếng Việt",
    ),
    e("h2", "", original ? a.title : a.translation?.title || a.title),
    e("div", "source-line", `${a.source} · ${a.category}`),
    e(
      "div",
      "saved-line",
      `Lưu ngày ${formatDay(a.saved_day)}${a.published_at ? " · Nguồn: " + a.published_at.slice(0, 32) : ""}`,
    ),
  );
  if (original) {
    const section = e("section", "summary-block");
    section.append(e("h3", "", "Nội dung gốc đã lưu"));
    if (a.content?.trim()) {
      if (a.metadata?.basis)
        section.append(e("p", "source-basis", `Trích đoạn nguồn: ${a.metadata.basis}.`));
      section.append(e("p", "excerpt", a.content));
    } else {
      section.append(
        e("p", "excerpt", "Không có nội dung gốc được lưu cho tin này. Mở nguồn để xem bài viết trên website nguồn."),
      );
    }
    panel.append(section);
  } else if (a.translation) {
    const displayed = a.translation;
    for (const [title, points] of [
      ["Điểm chính", displayed.key_points],
      ["Điều kiện & hạn chế", displayed.limitations],
    ]) {
      const section = e("section", "summary-block");
      section.append(e("h3", "", title));
      const ul = e("ul");
      for (const p of points) ul.append(e("li", "", p));
      section.append(ul);
      panel.append(section);
    }
    panel.append(
      e("p", "reason", displayed.reason),
      e(
        "p",
        "evidence",
        `${displayed.evidence} · Model: ${a.translation_model || a.summary_model}`,
      ),
    );
  }
  const actions = e("div", "article-actions"),
    link = e("a", "link-button primary", "↗ Mở nguồn");
  link.href = a.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  actions.append(
    button(
      original ? "Bản tóm tắt" : "Bản tin gốc",
      () => {
        state.previewMode = original ? "summary" : "original";
        renderPreview(a);
      },
    ),
    link,
    button(
      a.bookmarked ? "★ Đã lưu" : "☆ Lưu đọc sau",
      safe(() => patch(a, { bookmarked: !a.bookmarked })),
    ),
  );
  panel.append(actions);
  const feedback = e("div", "feedback");
  feedback.append(
    button(
      a.read ? "Đánh dấu chưa đọc" : "✓ Đánh dấu đã đọc",
      safe(() => patch(a, { read: !a.read })),
    ),
    button(
      "Hữu ích",
      safe(() =>
        patch(a, { feedback: a.feedback === "useful" ? "" : "useful" }),
      ),
      a.feedback === "useful" ? "selected" : "",
    ),
    button(
      "Ít tin tương tự",
      safe(() => patch(a, { feedback: a.feedback === "less" ? "" : "less" })),
      a.feedback === "less" ? "selected" : "",
    ),
  );
  panel.append(feedback);
}
function aiStatusText(status) {
  return {
    processing: "Đang xử lý AI. Bản tóm tắt sẽ xuất hiện khi hoàn chỉnh.",
    missing_key: "Chưa cấu hình OpenAI API key; tin nguồn vẫn được lưu.",
    missing_pricing: "Chưa cấu hình đơn giá model để xử lý AI.",
    daily_limit: "Đã đạt giới hạn 10 tin xử lý AI tự động hôm nay.",
    budget: "Đã đạt ngân sách AI trong ngày.",
    failed: "Xử lý AI lỗi; dữ liệu nguồn vẫn được lưu và có thể thử lại.",
    waiting: "Tin đang chờ được chọn để xử lý AI.",
  }[status] || "Chưa có bản tóm tắt.";
}
async function patch(a, changes) {
  const updated = await api("/articles/" + a.id, "PATCH", changes);
  if (state.selected === a.id) renderPreview(updated);
  await loadState();
  state.offset = 0;
  await loadList();
}
function initFilters() {
  $("#categories").replaceChildren(
    ...labels.map((label, i) =>
      button(
        label,
        safe(async () => {
          state.category = i ? label : "";
          state.offset = 0;
          $$("#categories button").forEach((b) =>
            b.classList.toggle("active", b.textContent === label),
          );
          await loadList();
        }),
        i ? "" : "active",
      ),
    ),
  );
  $$("[data-read]").forEach(
    (b) =>
      (b.onclick = safe(async () => {
        state.read = b.dataset.read;
        state.offset = 0;
        $$("[data-read]").forEach((x) => x.classList.toggle("active", x === b));
        await loadList();
      })),
  );
}
async function showCosts() {
  const target = $("#cost-content");
  target.textContent = "Đang tải…";
  const { rows, totals, recent } = await api(
    "/usage?days=" + $("#cost-range").value,
  );
  target.replaceChildren();
  const stats = e("div", "cost-stats");
  for (const [title, value] of [
    ["Chi phí ước tính", money(totals.cost)],
    ["Requests", num(totals.requests)],
    ["Tổng tokens", num(totals.input_tokens + totals.output_tokens)],
  ]) {
    const item = e("div", "cost-stat");
    item.append(e("span", "", title), e("strong", "", value));
    stats.append(item);
  }
  target.append(stats);
  if (totals.unknown)
    target.append(
      e(
        "p",
        "error",
        `${totals.unknown} request chưa xác định chi phí; tổng ở trên chỉ gồm chi phí đã biết.`,
      ),
    );
  const wrap = e("div", "table-wrap"),
    table = e("table"),
    head = e("tr");
  for (const t of [
    "Ngày / Model",
    "Tác vụ",
    "Requests",
    "Input",
    "Cached",
    "Output",
    "USD",
  ])
    head.append(e("th", "", t));
  const thead = e("thead");
  thead.append(head);
  table.append(thead);
  const tbody = e("tbody");
  for (const row of rows) {
    const tr = e("tr");
    [
      `${formatDay(row.day)} · ${row.model}`,
      row.task === "translation" ? "Dịch" : "Tóm tắt",
      num(row.requests),
      num(row.input_tokens),
      num(row.cached_tokens),
      num(row.output_tokens),
      money(row.cost) + (row.unknown ? " + ?" : ""),
    ].forEach((v, i) => tr.append(e("td", i > 1 ? "num" : "", v)));
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  target.append(wrap);
  if (!rows.length)
    target.append(
      e("p", "fineprint", "Chưa có lượt gọi AI trong khoảng thời gian này."),
    );
  for (const r of recent.filter((x) => x.error).slice(0, 5))
    target.append(e("p", "fineprint", `${r.model} · ${r.status}: ${r.error}`));
}
function showSettings() {
  const c = state.server.settings,
    f = $("#settings-form");
  f.reset();
  for (const k of [
    "model",
    "dailyBudget",
    "scheduleTime",
    "timezone",
    "autoLimit",
    "profile",
    "dailyFeedUrl",
  ])
    f.elements[k].value = c[k];
  f.elements.scheduleEnabled.checked = c.scheduleEnabled;
  for (const k of Object.keys(c.sources)) f.elements[k].checked = c.sources[k];
  const rssChecks = $("#rss-source-checks");
  rssChecks.replaceChildren(
    ...c.rssSources.map((source) => {
      const label = e("label");
      const input = e("input");
      input.type = "checkbox";
      input.name = `rssSource_${source.id}`;
      input.checked = source.enabled;
      label.append(input, document.createTextNode(` ${source.name || source.id}`));
      return label;
    }),
  );
  for (const [input, key] of [
    ["inputPrice", "input"],
    ["cachedPrice", "cached"],
    ["outputPrice", "output"],
  ])
    f.elements[input].value = c.prices?.[key] ?? "";
  const keySources = {
    system: "biến môi trường hệ thống",
    dotenv: "file .env",
    settings: "settings.json",
    none: "chưa cấu hình",
  };
  $("#key-status").textContent =
    `OpenAI: ${keySources[c.openaiKeySource]}. GitHub token: ${keySources[c.githubTokenSource]}. ` +
    (c.envOpenaiKey || c.envGithubToken
      ? "Key/token nhập hoặc xóa tại đây không thay thế cấu hình môi trường đang có hiệu lực."
      : "Key mới lưu trong settings.json với quyền 0600.");
  $("#settings-error").textContent = "";
  $("#settings-dialog").showModal();
}
$("#settings-form").onsubmit = async (event) => {
  event.preventDefault();
  const f = event.currentTarget,
    b = f.querySelector("button[type=submit]");
  const p = {};
  for (const k of [
    "model",
    "scheduleTime",
    "timezone",
    "profile",
    "dailyFeedUrl",
  ])
    p[k] = f.elements[k].value.trim();
  for (const k of ["dailyBudget", "autoLimit"])
    p[k] = Number(f.elements[k].value);
  p.scheduleEnabled = f.elements.scheduleEnabled.checked;
  p.prices = {
    input: Number(f.elements.inputPrice.value),
    cached: Number(f.elements.cachedPrice.value),
    output: Number(f.elements.outputPrice.value),
  };
  p.sources = Object.fromEntries(
    ["githubCopilot", "microsoft", "huggingface", "github", "daily"].map(
      (k) => [k, f.elements[k].checked],
    ),
  );
  p.rssSources = state.server.settings.rssSources.map((source) => ({
    ...source,
    enabled: f.elements[`rssSource_${source.id}`].checked,
  }));
  if (f.elements.openaiKey.value)
    p.openaiKey = f.elements.openaiKey.value.trim();
  if (f.elements.clearKey.checked) p.openaiKey = "";
  if (f.elements.githubToken.value)
    p.githubToken = f.elements.githubToken.value.trim();
  if (f.elements.clearGithub.checked) p.githubToken = "";
  b.disabled = true;
  try {
    const settings = await api("/settings", "PUT", p);
    const overridden = [];
    if (p.openaiKey !== undefined && settings.envOpenaiKey) overridden.push("OpenAI key");
    if (p.githubToken !== undefined && settings.envGithubToken) overridden.push("GitHub token");
    f.elements.openaiKey.value = "";
    f.elements.githubToken.value = "";
    $("#settings-dialog").close();
    await loadState();
    toast(overridden.length
      ? `Đã lưu cài đặt. ${overridden.join(", ")} trên giao diện bị cấu hình môi trường ghi đè.`
      : "Đã lưu cài đặt");
  } catch (err) {
    $("#settings-error").textContent = err.message;
  } finally {
    b.disabled = false;
  }
};
$("#settings-form").elements.model.addEventListener("change", () => {
  for (const k of ["inputPrice", "cachedPrice", "outputPrice"])
    $("#settings-form").elements[k].value = "";
  $("#settings-error").textContent =
    "Đã đổi model: hãy nhập đơn giá tương ứng để theo dõi chi phí.";
});
function showLogs() {
  const root = $("#logs-content");
  root.replaceChildren();
  for (const run of state.server.runs) {
    const d = JSON.parse(run.details),
      item = e("div", "log-entry");
    item.append(
      e(
        "strong",
        "",
        `${new Date(run.started_at).toLocaleString("vi-VN")} · ${run.status} · ${run.trigger}`,
      ),
      e(
        "div",
        "",
        `${d.inserted || 0} tin mới · ${d.summarized || 0} bản tóm tắt`,
      ),
    );
    const ul = e("ul");
    for (const s of d.sources || [])
      ul.append(e("li", "", `${s.name}: ${s.ok ? s.count + " tin" : s.error}`));
    for (const err of [...(d.aiErrors || []), d.aiSkipped, d.error].filter(
      Boolean,
    ))
      ul.append(e("li", "", err));
    item.append(ul);
    root.append(item);
  }
  if (!state.server.runs.length)
    root.append(e("p", "", "Chưa có lượt cập nhật."));
  $("#logs-dialog").showModal();
}
$$("[data-close]").forEach(
  (b) => (b.onclick = () => b.closest("dialog").close()),
);
$("#cost-button").onclick = safe(async () => {
  $("#cost-dialog").showModal();
  await showCosts();
});
$("#cost-range").onchange = safe(showCosts);
$("#nav-settings").onclick = showSettings;
$("#run-log").onclick = showLogs;
$("#refresh").onclick = safe(async () => {
  await api("/refresh", "POST", {});
  await loadState();
  toast("Đã bắt đầu thu thập; bạn có thể tiếp tục đọc tin.");
});
$("#day-picker").onchange = safe(() =>
  chooseDay($("#day-picker").value || state.server.today),
);
$("#nav-news").onclick = safe(() => chooseDay(state.server.today));
$("#nav-saved").onclick = safe(async () => {
  state.saved = true;
  state.offset = 0;
  state.selected = null;
  state.previewMode = "summary";
  $("#nav-news").classList.remove("active");
  $("#nav-saved").classList.add("active");
  await loadList();
  renderPreview(null);
});
$("#only-recommended").onchange = safe(async () => {
  state.recommended = $("#only-recommended").checked;
  state.offset = 0;
  await loadList();
});
let searchTimer;
$("#search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(
    safe(async () => {
      state.q = $("#search").value;
      state.offset = 0;
      await loadList();
    }),
    250,
  );
};
$("#load-more").onclick = safe(async () => {
  state.offset = state.items.length;
  await loadList(true);
});
initFilters();
await safe(async () => {
  await loadState();
  await loadList();
})();
let polling = false;
setInterval(async () => {
  if (polling || document.hidden) return;
  polling = true;
  try {
    const was = state.server?.running;
    const old = state.server?.lastRun?.id;
    await loadState();
    if ((was && !state.server.running) || old !== state.server.lastRun?.id) {
      state.offset = 0;
      await loadList();
      if (state.selected) await selectArticle(state.selected);
    }
  } catch {
    $("#run-status").textContent =
      "Mất kết nối backend. Kiểm tra service DevPulse.";
  } finally {
    polling = false;
  }
}, 4000);
