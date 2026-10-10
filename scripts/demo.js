import path from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "../src/config.js";
import { Store } from "../src/db.js";
import { localClock } from "../src/utils.js";
import { environment, prepareDataDir } from "../src/environment.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "data", "demo");
process.umask(0o077);
const { port } = environment.runtime();
prepareDataDir(dir);
const config = new Config(dir, { secretsEnabled: false });
config.update({ scheduleEnabled: false, openaiKey: "" });
const db = new Store(path.join(dir, "devpulse.db"));
const day = localClock().day;
const titles = [
  "Chuẩn hóa instruction cho GitHub Copilot",
  "Kết nối tool với agent qua MCP",
  "Thiết kế workflow cho Microsoft Copilot",
  "Đánh giá prompt bằng test cases",
  "Quản lý context cho coding agent",
  "Structured output cho AI workflow",
];
db.ingest(
  titles.map((title, i) => ({
    title,
    source: "DEMO · Nội dung minh họa",
    url: "https://example.com/demo/" + i,
    content:
      "Dữ liệu minh họa giao diện. Đây không phải tin cập nhật thực tế. Chọn một task nhỏ để kiểm tra instruction, context và khả năng gọi tool của agent.",
    metadata: { basis: "demo" },
  })),
  day,
);
const first = db.get("SELECT id FROM articles WHERE title=?", titles[0]);
const summary = {
  category: "Copilot",
  relevance: 8,
  actionable: 7,
  hype: 1,
  recommendation: "xem",
  reason: "Minh họa workflow dùng GitHub Copilot trong repository.",
  evidence: "Dữ liệu demo, không phải kết luận từ tài liệu thực.",
  key_points: [
    "Tập trung coding convention và yêu cầu kiểm tra vào instruction.",
    "Bổ sung context để agent chỉnh sửa code nhất quán với dự án.",
    "Phù hợp với workflow phát triển software bằng Copilot.",
  ],
  limitations: [
    "Kiểm tra môi trường hỗ trợ và phạm vi áp dụng.",
    "Đây là bản tóm tắt minh họa, không phải tin đã xác minh.",
  ],
};
db.run(
  "UPDATE articles SET summary=?,summary_model=?,recommended=1 WHERE id=?",
  JSON.stringify(summary),
  "demo",
  first.id,
);
db.close();
const { createApp } = await import("../src/server.js");
const app = createApp({ dataDir: dir, disableSchedule: true, secretsEnabled: false });
app.server.on("error", () => {
  console.error("Không thể khởi động demo; kiểm tra cổng và quyền truy cập.");
  process.exit(1);
});
app.server.listen(port, "127.0.0.1", () =>
  console.log(
    `DEMO không gọi AI — http://localhost:${port} · dữ liệu riêng tại data/demo/`,
  ),
);
