#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ml_dir="$(cd "${script_dir}/.." && pwd)"
dataset_root="${WARDY_DATASET_ROOT:-${ml_dir}/datasets}"

exec python3 "${ml_dir}/src/dataset_manager.py" \
  --dataset-root "${dataset_root}" install m05_hazard "$@"
