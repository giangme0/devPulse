#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ "${EUID}" -eq 0 ]]; then echo 'Chạy script bằng user Ubuntu của bạn, không dùng sudo.'; exit 1; fi
NODE_BIN="$(command -v node)"
"$NODE_BIN" -e 'if(Number(process.versions.node.split(".")[0])!==24){console.error("Cần Node.js 24 LTS");process.exit(1)}'
npm ci --ignore-scripts
APP_DIR="$(pwd -P)"
if [[ "$APP_DIR" == *'"'* || "$APP_DIR" == *'%'* || "$APP_DIR" == *'\\'* ]]; then echo 'Đặt thư mục ở đường dẫn không có dấu nháy, % hoặc backslash.'; exit 1; fi
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/devpulse.service" <<UNIT
[Unit]
Description=DevPulse AI local web app and daily scheduler
After=network.target

[Service]
Type=simple
WorkingDirectory="$APP_DIR"
ExecStart="$NODE_BIN" "$APP_DIR/src/server.js"
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
TimeoutStopSec=15

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now devpulse.service
if [[ "${1:-}" == '--linger' ]]; then sudo loginctl enable-linger "$USER"; fi
printf '%s\n' 'Đã bật service. Mở http://localhost:3000' 'Muốn chạy từ lúc boot, kể cả chưa đăng nhập: sudo loginctl enable-linger "$USER"' 'Log: journalctl --user -u devpulse.service -f'
