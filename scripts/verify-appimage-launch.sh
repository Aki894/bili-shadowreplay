#!/usr/bin/env bash
set -euo pipefail

root=$(realpath "${1:?Usage: verify-appimage-launch.sh APPDIR}")
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/home" "$scratch/config" "$scratch/data" "$scratch/cache"
set +e
timeout --kill-after=5s 25s xvfb-run -a env -u LD_LIBRARY_PATH -u LD_PRELOAD \
  HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/config" \
  XDG_DATA_HOME="$scratch/data" XDG_CACHE_HOME="$scratch/cache" \
  LD_DEBUG=libs "$root/AppRun" > "$scratch/launch.log" 2>&1
status=$?
set -e
if [ "$status" -ne 124 ]; then
  cat "$scratch/launch.log"
  echo "AppRun exited early (status $status); expected it to remain running" >&2
  exit 1
fi
node scripts/bundle-linux-ffmpeg.mjs \
  --verify-launch "$scratch/launch.log" \
  --binary "$root/usr/bin/bili-shadowreplay" \
  --runtime "$root/usr/lib/bili-shadowreplay/ffmpeg-runtime" \
  --package-root "$root"
