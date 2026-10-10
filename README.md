# DevPulse AI — Local Tech Reader

Ứng dụng đọc tin AI cá nhân chạy trên **Ubuntu**, mở bằng trình duyệt tại **http://localhost:3000**. Frontend HTML/CSS/JavaScript thuần; backend Node.js HTTP thuần; SQLite lưu trên máy. Không dùng React, Vue, Express, server framework hoặc dịch vụ database bên ngoài.

## 1. Cài và chạy trên Ubuntu

Yêu cầu: **Node.js 24 LTS** (kèm npm), internet và một OpenAI API key nếu dùng AI. `node:sqlite` có sẵn trong Node 24; không cần cài SQLite server hay Python. Kiểm tra:

```bash
node --version
npm --version
```

Nếu chưa có Node 24, cài theo hướng dẫn chính thức: https://nodejs.org/en/download (chọn Linux và Node 24). Không dùng bản Node cũ từ kho apt nếu phiên bản không đạt yêu cầu.

Giải nén ZIP, vào thư mục `devpulse`:

```bash
cd devpulse
chmod +x start.sh install-service.sh uninstall-service.sh
./start.sh
```

Mở **http://localhost:3000**. Lần chạy đầu script tự chạy `npm ci --ignore-scripts`. Vào **Cài đặt**:

1. Nhập OpenAI API key. Không nhập key vào JavaScript frontend.
2. Giữ model `gpt-4.1-mini` hoặc chọn model OpenAI hỗ trợ Responses API + Structured Outputs mà tài khoản của bạn có quyền dùng.
3. Kiểm tra đơn giá input/cached input/output. Đơn giá mặc định cho `gpt-4.1-mini` là 0.40 / 0.10 / 1.60 USD cho 1 triệu tokens, đối chiếu tài liệu OpenAI ngày 10/10/2026. Giá có thể thay đổi. Đổi model phải nhập lại giá.
4. Giữ lịch **06:00, Asia/Ho_Chi_Minh** hoặc đổi theo nhu cầu. Máy Ubuntu có thể dùng UTC; app vẫn theo timezone cấu hình.
5. Lưu, bấm **Cập nhật ngay** để chạy lần đầu có AI. Nếu đã lấy tin trước khi thêm key, thao tác này sẽ xử lý các tin chưa tóm tắt trong ngày.

ChatGPT subscription không phải API key của ứng dụng. App không tự lấy key từ tài khoản ChatGPT. Tài liệu API: https://developers.openai.com/api/docs/quickstart

### Cấu hình bằng `.env`

Có thể cấu hình key và môi trường chạy trong file local ở thư mục gốc dự án:

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

```dotenv
OPENAI_API_KEY=
GITHUB_TOKEN=
PORT=3000
DEVPULSE_DATA_DIR=./data
```

Điền OpenAI API key sau dấu `=`; GitHub token tùy chọn. Không đưa key vào frontend, log hoặc câu lệnh chia sẻ. `.env` bị Git bỏ qua; khi đóng gói/chia sẻ chỉ kèm `.env.example` với key rỗng, không kèm `.env` hay `data/`.

Node.js 24 đọc `.env` bằng API có sẵn, trước khi khởi tạo cấu hình, SQLite và HTTP server; không cần thêm dependency. Áp dụng thống nhất cho `npm start`, `start.sh` và systemd. File `.env` luôn được tìm theo thư mục gốc dự án, không theo thư mục chạy lệnh. `DEVPULSE_DATA_DIR` tương đối cũng tính từ gốc dự án; có thể dùng đường dẫn tuyệt đối. `PORT` phải là số nguyên từ 1 đến 65535. Nếu thư mục dữ liệu không ghi được, ứng dụng dừng với thông báo lỗi không chứa giá trị cấu hình.

Thứ tự ưu tiên: **biến môi trường hệ thống → `.env` → `settings.json` → mặc định**. Key/token rỗng hoặc chỉ có khoảng trắng được xem là chưa cấu hình và dùng nguồn tiếp theo. `PORT` và `DEVPULSE_DATA_DIR` là cấu hình startup, không lưu trong `settings.json`; mặc định là `3000` và `./data`. Không có `.env` vẫn chạy như trước.

**Cài đặt** hiển thị nguồn OpenAI key và GitHub token đang dùng. Key nhập qua giao diện vẫn được lưu vào `settings.json`, nhưng cấu hình môi trường có hiệu lực sẽ ghi đè; giao diện thông báo khi lưu. Backend không trả giá trị key về trình duyệt và không sao chép key từ `.env` vào `settings.json`.

Sau khi sửa `.env`, dừng và chạy lại phiên terminal, hoặc restart service:

```bash
systemctl --user restart devpulse.service
```

Không tự reload `.env`. Nếu đổi `PORT`, mở trình duyệt tại cổng mới.

## 2. Chạy tự động khi Ubuntu khởi động

Dừng phiên `./start.sh` bằng Ctrl+C trước khi cài service để giải phóng cổng 3000.

```bash
./install-service.sh --linger
```

Script tạo **systemd user service** tên `devpulse.service`, bật service và gọi `sudo loginctl enable-linger "$USER"` để service chạy sau boot ngay cả khi chưa đăng nhập. Chạy script bằng user thường, không chạy cả script bằng sudo. Chỉ thao tác bật linger có thể hỏi mật khẩu sudo.

Ứng dụng kiểm tra lịch mỗi 30 giây; mặc định cập nhật từ 06:00 giờ Việt Nam. Không cần mở tab trình duyệt. Không cần cron hoặc systemd timer thứ hai.

```bash
systemctl --user status devpulse.service
journalctl --user -u devpulse.service -f
systemctl --user restart devpulse.service
systemctl --user stop devpulse.service
```

Log mặc định là text một dòng/event, ghi ra stdout/stderr và xem bằng `journalctl`. Mỗi HTTP request chỉ ghi dòng kết quả với method, URL, status và `durationMs`; 4xx hiện `WARN`, 5xx hiện `ERROR`. `/api/state` chỉ ghi trạng thái chạy, số tin/chưa đọc, kết quả lượt chạy cuối và lỗi nguồn/AI; không lặp lịch sử hay settings. Danh sách bài viết chỉ ghi số lượng, feed text chỉ ghi số byte, response AI giữ usage thay vì toàn bộ output. Payload khác giới hạn độ dài/độ sâu; stack trace chỉ có ở debug. Credential trong trường thông dụng như API key, token, authorization, cookie và password vẫn được che.

Thêm vào `.env` rồi restart app/service để chọn cách hiển thị:

```dotenv
LOG_LEVEL=info
LOG_FORMAT=text
```

`LOG_LEVEL`: `debug`, `info` (mặc định), `warn`, `error`. Chọn `warn` để chỉ xem cảnh báo/lỗi, bỏ các dòng polling thành công. `LOG_FORMAT=json` xuất JSON một dòng cho công cụ xử lý log; mặc định là `text`. Biến môi trường hệ thống ưu tiên hơn `.env`.

```bash
# Xem log live, không lặp metadata của journal
journalctl --user -u devpulse.service -f -o cat
# Debug tạm thời khi chạy terminal
LOG_LEVEL=debug LOG_FORMAT=json npm start
```

Debug ghi cả request và response đầy đủ sau khi che credential, có thể chứa prompt, nội dung bài viết hoặc dữ liệu cấu hình khác. Chỉ bật khi cần và giới hạn quyền truy cập/thời gian lưu log như dữ liệu cá nhân.

- Máy phải bật, không sleep và có mạng. App không đánh thức máy từ suspend.
- Nếu tắt máy lúc đến lịch, sau khi bật lại app chạy bù **một lượt cho ngày hiện tại**, không giả lập lại dữ liệu của từng ngày máy đã tắt.
- Nếu toàn bộ nguồn lỗi, scheduler thử lại sau khoảng 30 phút. Nếu một phần nguồn lỗi, vẫn lưu tin của các nguồn tốt; xem **Lịch sử cập nhật**, bấm cập nhật lại khi cần.
- Scheduler không chạy lại tự động khi đã có lượt cập nhật thành công/một phần trong ngày. Bấm cập nhật thủ công vẫn được; hạn mức AI giữ nguyên.
- Nếu đổi lịch/timezone sau khi đã chạy trong ngày, thay đổi áp dụng cho các lần kiểm tra tiếp theo, không tự xử lý lại ngày đã hoàn thành.
- Đường dẫn Node được ghi tuyệt đối vào service. Nếu đổi vị trí source hoặc xóa phiên bản Node (ví dụ qua nvm), chạy lại `install-service.sh`.
- Gỡ service: `./uninstall-service.sh`. Dữ liệu không bị xóa. Script không tắt linger vì các service khác có thể cần nó.

Nếu không có quyền bật linger, `./install-service.sh` vẫn chạy service trong phiên user nhưng không bảo đảm tự chạy trước lúc đăng nhập sau reboot.

Service mới không đặt cứng `PORT`, để `.env` có hiệu lực. Với service đã cài bằng bản cũ, xóa dòng `Environment=PORT=3000` trong `~/.config/systemd/user/devpulse.service`, rồi chạy `systemctl --user daemon-reload` và restart. Hoặc dừng service rồi chạy lại `./install-service.sh` để tạo lại unit. Biến môi trường bạn chủ động đặt trong unit vẫn ưu tiên hơn `.env`; không cần và không nên thêm `EnvironmentFile=` cho file này.

## 3. Hành vi sản phẩm

### Tin, ngày và lưu trữ

- Lưu **tất cả tin trong các batch đã thu thập**, kể cả tin không được AI chọn. Mỗi nguồn lấy tối đa 6 tin/lượt, tối đa 30 khi bật cả 5 nguồn; đây không phải crawler toàn bộ Internet hoặc toàn bộ lịch sử nguồn.
- `saved_day` là **ngày đầu tiên thu thập** theo timezone cấu hình, không phải ngày xuất bản. Ngày xuất bản được lưu riêng.
- Lịch và bộ chọn ngày mở lại tin của ngày đó. Không tự xóa dữ liệu, không có thời hạn lưu trữ.
- Khử trùng bằng canonical URL: bỏ fragment, tham số tracking và dấu `/` cuối. Tin cũ giữ nguyên ngày lưu, trạng thái đọc và bookmark.
- Mở một tin bằng cách click sẽ tự đánh dấu **Đã đọc**. Nút trong preview có thể chuyển tin về **Chưa đọc**; hai bộ lọc phản ánh trạng thái này.
- **Đã lưu đọc sau** là bookmark, không phải mọi tin trong DB; mục này tìm trên tất cả ngày.
- Có tìm kiếm, lọc chủ đề, lọc Đáng xem và phân trang 50 tin. Các bộ lọc kết hợp với nhau.

### AI và anti-hype

- Bước đầu dùng rule để xếp ứng viên: ưu tiên Copilot, agent/MCP, prompt/context và nội dung kỹ thuật; giảm điểm quảng cáo/gọi vốn.
- Mỗi ngày thực hiện tối đa **10 request tóm tắt tự động** (có thể chỉnh 1–10). Lỗi vẫn tính vào số lượt để tránh retry vô hạn và phát sinh chi phí. Chạy lại hoặc restart không reset hạn mức vì lịch sử nằm trong SQLite.
- AI đánh giá độ phù hợp, khả năng áp dụng, hype, căn cứ; không loại tin chỉ vì có từ marketing.
- **Đáng xem**: AI đề xuất `xem` và relevance >= 6, tối đa 10 tin/ngày lưu. Có thể ít hơn 10; đây không phải số lượng bắt buộc.
- Preview có hai phần: **Điểm chính** (1–3 ý tích hợp nội dung, ứng dụng, lý do) và **Điều kiện & hạn chế** (1–2 ý). Tổng tối đa 5 ý. Bản summary được dịch sang tiếng Việt, giữ nguyên technical keywords tiếng Anh; nội dung nguồn và summary gốc vẫn được lưu riêng.
- Tin khác giữ trích đoạn nguồn và nút **Tóm tắt bằng AI**. Lượt thủ công không thuộc trần 10 tin tự động nhưng dùng chung ngân sách ngày. Tin được tự động chọn tóm tắt sẽ được dịch tiếp; tin đã có summary có nút **Dịch sang tiếng Việt** riêng. Translation và summary cache độc lập, không gọi lại khi mở tin.
- Nếu chỉ có abstract/RSS/description thì AI phải nêu giới hạn. Ứng dụng không tự đọc mọi trang đích hoặc chạy code repo.
- Nút **Hữu ích** lưu phản hồi; **Ít tin tương tự** giảm nhẹ thứ hạng ứng viên của cùng category trong các lượt sau. Đây là heuristic đơn giản, chưa có mô hình học cá nhân hóa.

### Chi phí

- Nút **Chi phí AI** ở thanh đầu trang mở dialog toàn ứng dụng. Không hiển thị cost trên từng bản tin.
- Thống kê ngày/model/task (tóm tắt hoặc dịch): requests, input, cached input, output và USD ước tính; có hôm nay / 7 ngày / 30 ngày / toàn bộ.
- Mỗi request lưu snapshot đơn giá. Đổi giá không viết lại chi phí lịch sử.
- Cached input là tập con của input. Công thức: `(input - cached) × inputPrice + cached × cachedPrice + output × outputPrice`, chia 1 triệu.
- Không dùng tool web search của OpenAI nên không có phí tool search được tính trong app.
- Ngân sách mặc định **1 USD/ngày** dùng chi phí đã biết + dự phòng dựa trên kích thước prompt/output tối đa. Đây là rào chắn của app, **không phải hard spending limit của nhà cung cấp**.
- Request timeout hoặc app dừng giữa chừng có thể đã phát sinh phí nhưng không nhận được usage. Dialog ghi `unknown`/`?`, không báo 0 USD cho những request đó. Dự phòng được giữ để hạn chế gọi thêm trong ngày. Đối chiếu dashboard OpenAI khi cần.
- AI trả JSON lỗi nhưng có usage: vẫn ghi nhận chi phí. Không tự retry GPT để tránh tính phí trùng khi phản hồi không rõ.

## 4. Nguồn dữ liệu

| Nguồn               | Cách lấy                                            | Phạm vi / giới hạn                                                                                   |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GitHub Copilot      | `https://github.blog/changelog/label/copilot/feed/` | 6 mục đầu RSS chính thức                                                                             |
| Microsoft Blog      | `https://blogs.microsoft.com/feed/`                 | 6 mục đầu; có thể bao gồm tin doanh nghiệp không liên quan, bộ lọc sẽ xếp thấp                       |
| Hugging Face Papers | `https://huggingface.co/api/daily_papers`           | 6 papers nhiều upvote nhất trong tập phản hồi mới nhất; không đo mức tăng upvote trong 24h           |
| GitHub Search       | GitHub REST search repositories                     | 3 Python + 3 TypeScript, topic `ai-agent`, tạo trong 30 ngày, sort stars; không phải GitHub Trending |
| daily.dev           | RSS cá nhân do bạn nhập                             | Tắt mặc định; chỉ chấp nhận HTTPS `rss-app.daily.dev` hoặc `daily.dev`; không tự tạo token           |

GitHub token tùy chọn giúp tránh giới hạn unauthenticated. API key/RSS cá nhân chỉ dùng tại backend. Nếu RSS đổi domain cần cập nhật whitelist ở `src/config.js`. Nguồn lỗi độc lập không làm mất các tin đã lưu.

Hiện khử trùng theo URL, **chưa gom semantic cluster** cho nhiều bài cùng một sự kiện. Một repo giữ nguyên URL sẽ không sinh tin mới mỗi lần nội dung thay đổi; release notes riêng URL vẫn là tin mới. Đây là giới hạn MVP được ghi rõ, không giả định đã giải quyết hoàn toàn.

## 5. Dữ liệu, backup, quyền truy cập

```text
data/
  devpulse.db       # articles, runs, ai_calls, meta
  devpulse.db-wal   # có thể tồn tại khi chạy
  devpulse.db-shm
  settings.json    # cấu hình + API key local, quyền 0600
```

Thư mục mặc định `data/`, có thể đổi qua `DEVPULSE_DATA_DIR`. Backend chỉ bind `127.0.0.1`; không mở cho LAN. Có Host/Origin check và header bảo vệ mutation. Nội dung nguồn hiển thị bằng `textContent`, không inject HTML nguồn. API không trả key đã lưu cho frontend; tệp cấu hình không nằm trong thư mục public.

Key được bảo vệ bằng file permissions, **không được mã hóa at rest**. Người có quyền user/root trên máy có thể đọc. Có thể dùng biến môi trường `OPENAI_API_KEY` và `GITHUB_TOKEN` hoặc `.env`; chúng ưu tiên hơn key trong Cài đặt. Giữ `.env` ở quyền `600`. Không commit hoặc chia sẻ `.env` hay thư mục `data/`.

Backup an toàn khi dùng service:

```bash
systemctl --user stop devpulse.service
mkdir -p backups
cp -a data "backups/data-$(date +%Y%m%d-%H%M%S)"
systemctl --user start devpulse.service
```

Nếu đang chạy bằng terminal, Ctrl+C trước khi backup. Không chỉ copy riêng DB đang mở mà bỏ WAL. Giữ bảo mật cho backup vì có thể chứa API key.

## 6. Cấu trúc source

```text
public/              HTML, CSS, browser JavaScript; không build step
src/server.js        Node HTTP, REST routes, bảo vệ localhost
src/config.js        Cấu hình, validation, lưu key local
src/environment.js   Đọc .env bằng Node builtin, ưu tiên nguồn, cấu hình startup
src/db.js            SQLite schema, lưu tin, lịch sử, usage
src/sources.js       RSS/Atom, HF Papers, GitHub Search
src/ai.js            OpenAI Responses, JSON schema, cost, budget
src/pipeline.js      Ingestion, chọn ứng viên, scheduler, catch-up
src/utils.js         Ngày/timezone, canonical URL, phân loại, cost
scripts/demo.js      Demo riêng, không dùng key hoặc schedule
test/app.test.js     Kiểm thử nghiệp vụ và HTTP
test/config.test.js  Kiểm thử .env, startup, đường dẫn, secrets và demo
.env.example         Mẫu cấu hình local, không chứa key
start.sh             Chạy terminal
install-service.sh   Cài systemd user service
uninstall-service.sh Gỡ service, giữ dữ liệu
```

Chỉ một dependency runtime: `fast-xml-parser` để đọc RSS/Atom. Node builtin xử lý HTTP, fetch, SQLite, filesystem. `package-lock.json` cố định phiên bản.

## 7. Kiểm thử và demo

```bash
npm ci --ignore-scripts
npm test
npm run demo
```

Demo chạy cổng từ `PORT` (mặc định 3000), **tắt scheduler, không gọi GPT**, dùng database riêng `data/demo/` bất kể `DEVPULSE_DATA_DIR`. Demo bỏ qua mọi OpenAI key/GitHub token từ môi trường, `.env` và Cài đặt, kể cả khi nhập key trên giao diện demo. Dừng service thật trước khi chạy demo nếu dùng chung cổng; Ctrl+C demo rồi bật lại service sau khi xem. Tin demo có nhãn DEMO và liên kết example.com.

Bộ test không dùng key và không tính phí. Kiểm thử Responses API bằng mock bao gồm quota 10/ngày, request lỗi, unknown usage, cached token cost, anti-CSRF/Host, RSS/Atom, khử trùng, permission và schedule.

Kiểm thử cấu hình dùng `.env` và dữ liệu giả trong thư mục tạm: thứ tự ưu tiên, key rỗng, đường dẫn khi chạy từ thư mục khác, startup với port/thư mục không hợp lệ, không lộ key qua HTTP/log hoặc sao chép vào settings, demo không dùng database thật và không gọi GPT. Kiểm tra quyền Unix `0600` chạy trên Unix; Windows không hỗ trợ cùng cơ chế file mode.

Live GPT chỉ có thể xác nhận sau khi bạn nhập key hợp lệ. Việc tạo systemd service cần kiểm tra trên Ubuntu thực của bạn; container tạo source không vận hành systemd của máy bạn.

## 8. Tài liệu kỹ thuật đã đối chiếu

- OpenAI Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses
- OpenAI model/pricing: https://developers.openai.com/api/docs/models/gpt-4.1-mini
- Node 24 SQLite: https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html
- Hugging Face Papers: https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api#huggingface_hub.HfApi.list_daily_papers
- GitHub repository search: https://docs.github.com/en/rest/search/search#search-repositories
- daily.dev: https://docs.daily.dev/public-api/
