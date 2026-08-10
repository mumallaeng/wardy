#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV_DIR="${WARDY_VENV_DIR:-$PROJECT_ROOT/venv}"
PYTHON_BIN="${PYTHON_BIN:-python3.10}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
    echo "Apple Silicon macOS 전용 setup"
    exit 1
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

"$VENV_DIR/bin/python" -m pip install \
    -r "$PROJECT_ROOT/ml/requirements/m03.txt"

echo "venv: $VENV_DIR"
echo "activate: source $VENV_DIR/bin/activate"
