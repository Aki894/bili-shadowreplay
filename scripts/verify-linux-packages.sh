#!/usr/bin/env bash
set -euo pipefail

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
bundle="$PWD/src-tauri/target/release/bundle"
verify() {
  node scripts/bundle-linux-ffmpeg.mjs --verify \
    --binary "$1/usr/bin/bili-shadowreplay" \
    --runtime "$1/usr/lib/bili-shadowreplay/ffmpeg-runtime" \
    --package-root "$1"
}
shopt -s nullglob
debs=("$bundle"/deb/*.deb)
rpms=("$bundle"/rpm/*.rpm)
images=("$bundle"/appimage/*.AppImage)
[[ ${#debs[@]} == 1 && ${#rpms[@]} == 1 && ${#images[@]} == 1 ]]
dpkg-deb -x "${debs[0]}" "$root/deb"
verify "$root/deb"
mkdir "$root/rpm"
rpm2cpio "${rpms[0]}" | (cd "$root/rpm" && cpio -idm --quiet)
verify "$root/rpm"
image="${images[0]}"
(cd "$root" && "$image" --appimage-extract > /dev/null)
verify "$root/squashfs-root"

# Install the actual deb in a clean supported distro, not the SDK-bearing runner.
docker run --rm -v "${debs[0]}:/tmp/bsr.deb:ro" ubuntu:24.04 bash -euc '
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/bsr.deb
  result=$(ldd /usr/bin/bili-shadowreplay)
  printf "%s\n" "$result"
  ! grep -q "not found" <<< "$result"
  grep -E "libavformat.so.63 => /usr/(bin/../)?lib/bili-shadowreplay/ffmpeg-runtime/" <<< "$result"
'
