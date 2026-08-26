#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
[ -d node_modules ] || { echo "Dependencies are missing. Run ./install.sh first."; exit 1; }
npm start
