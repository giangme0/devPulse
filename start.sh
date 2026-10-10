#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null; then echo 'Cần Node.js 24 LTS. Xem README.md.'; exit 1; fi
node -e 'if(Number(process.versions.node.split(".")[0])!==24){console.error("Cần Node.js 24 LTS");process.exit(1)}'
if [[ ! -d node_modules/fast-xml-parser ]]; then npm ci --ignore-scripts; fi
exec node src/server.js
