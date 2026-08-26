#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Install Node.js 24 LTS first."; exit 1; }
node -e "const major=Number(process.versions.node.split('.')[0]); if(major<24) process.exit(1)" || { echo "Node.js 24+ is required."; exit 1; }
[ -f .env ] || cp .env.example .env
npm install
npm run build
echo "Installation complete. Run ./start.sh"
