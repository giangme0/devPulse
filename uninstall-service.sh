#!/usr/bin/env bash
set -euo pipefail
systemctl --user disable --now devpulse.service
rm -f "$HOME/.config/systemd/user/devpulse.service"
systemctl --user daemon-reload
printf '%s\n' 'Đã gỡ service. Database và cài đặt được giữ nguyên.'
