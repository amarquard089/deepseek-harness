#!/bin/sh
set -eu

state_dir=/run/dsh-web
launch_file="$state_dir/launch-url"
mkdir -p "$state_dir"
rm -f "$launch_file"

pnpm dsh --profile web --patch /run/dsh-config/azure-ai-foundry.patch.yml \
  --no-open \
  --host 0.0.0.0 \
  --allow-insecure-host \
  --port "${DSH_WEB_PORT:-3080}" \
  --public-url "http://dsh-web:${DSH_WEB_PORT:-3080}" \
  --trusted-host dsh-web 2>&1 | while IFS= read -r line; do
    printf '%s\n' "$line"
    case "$line" in
      dsh\ web:\ *) printf '%s\n' "${line#dsh web: }" | cut -d ' ' -f1 > "$launch_file" ;;
    esac
  done
