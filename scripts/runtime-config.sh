#!/usr/bin/env bash
# Only non-secret launch metadata is sent to the native desktop shell.
set -euo pipefail
. "$(dirname "$0")/_common.sh"
NODE_BIN="$(find_node)" || exit 1
"$NODE_BIN" -e 'const cfg = require(process.argv[1]); console.log(JSON.stringify({url: `http://127.0.0.1:${cfg.PORT}`}));' "$REPO_ROOT/config.js"
