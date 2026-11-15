#!/usr/bin/env bash
set -euo pipefail

# Execute the real HLS tests from the installed layout with no SDK loader path.
# This covers object recording, resume, failures and cancellation, not just ldd.
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
cargo test --manifest-path src-tauri/Cargo.toml -p ffmpeg_utils --lib --locked \
  --no-run --message-format=json > "$root/build.json"
binary=$(node --input-type=module - "$root/build.json" <<'NODE'
import fs from "node:fs";
const artifacts = fs.readFileSync(process.argv[2], "utf8").trim().split("\n").map(JSON.parse)
  .filter(entry => entry.reason === "compiler-artifact" && entry.target.name === "ffmpeg_utils" && entry.executable);
if (artifacts.length !== 1) throw new Error("Expected one ffmpeg_utils test executable");
console.log(artifacts[0].executable);
NODE
)
mkdir -p "$root/usr/bin"
cp "$binary" "$root/usr/bin/hls-tests"
runtime="$root/usr/lib/bili-shadowreplay/ffmpeg-runtime"
node scripts/bundle-linux-ffmpeg.mjs --binary "$root/usr/bin/hls-tests" --runtime "$runtime"
node scripts/bundle-linux-ffmpeg.mjs --verify --binary "$root/usr/bin/hls-tests" --runtime "$runtime"
env -u LD_LIBRARY_PATH -u LD_PRELOAD "$root/usr/bin/hls-tests" hls::
