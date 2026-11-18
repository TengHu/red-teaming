#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
VW_URL="https://github.com/TengHu/visual-workbench.git"
VW_COMMIT="eab11012079f62748267a97e473a9de18ddadeed"
MANAGED_VW="$REPO_ROOT/oss/visual-workbench"

ENV_FILE=""
for candidate in "$REPO_ROOT/.env" "$HERE/.env"; do
  if [[ -f "$candidate" ]]; then
    ENV_FILE="$candidate"
    break
  fi
done
if [[ -n "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${OPENROUTER_API_KEY:-}" && -z "${GATEWAY_API_KEY:-}" ]]; then
  echo "Set OPENROUTER_API_KEY or GATEWAY_API_KEY in $REPO_ROOT/.env or the environment." >&2
  exit 1
fi

if [[ -n "${VW_ROOT:-}" ]]; then
  VW_ROOT="$(cd "$VW_ROOT" && pwd)"
  [[ -x "$VW_ROOT/vw" ]] || {
    echo "VW_ROOT does not contain an executable vw: $VW_ROOT" >&2
    exit 1
  }
  current="$(git -C "$VW_ROOT" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$current" != "$VW_COMMIT" ]]; then
    echo "Warning: VW_ROOT is at ${current:-an unknown revision}; the graduated run used $VW_COMMIT." >&2
  fi
else
  VW_ROOT="$MANAGED_VW"
  if [[ ! -d "$VW_ROOT/.git" ]]; then
    mkdir -p "$(dirname "$VW_ROOT")"
    git clone "$VW_URL" "$VW_ROOT"
  fi
  if [[ "$(git -C "$VW_ROOT" rev-parse HEAD)" != "$VW_COMMIT" ]]; then
    git -C "$VW_ROOT" fetch origin main
    git -C "$VW_ROOT" checkout --detach "$VW_COMMIT"
  fi
fi

if [[ ! -x "$VW_ROOT/.venv/bin/python" ]]; then
  "$VW_ROOT/vw" setup
fi

if [[ ! -d "$HERE/encoder/node_modules/hersheytext" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to install the stroke encoder dependency." >&2
    exit 1
  fi
  (cd "$HERE/encoder" && npm install --silent)
fi

exec "$VW_ROOT/.venv/bin/python" -I "$HERE/run.py" "$VW_ROOT" "$@"
