import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseDependencies, systemLibrary } from "../bundle-linux-ffmpeg.mjs";

test("Linux media bundling keeps only the core runtime on the host", () => {
  for (const name of ["libc.so.6", "libm.so.6", "ld-linux-x86-64.so.2", "libstdc++.so.6", "libgcc_s.so.1"]) {
    assert.equal(systemLibrary(name), true, name);
  }
  for (const name of ["libavformat.so.63", "libx264.so.164", "libssl.so.3", "libass.so.9", "libfontconfig.so.1"]) {
    assert.equal(systemLibrary(name), false, name);
  }
});

test("Linux dependency parsing includes transitive libraries and fails on missing libraries", () => {
  assert.deepEqual([...parseDependencies(`
    linux-vdso.so.1 (0x00007ffd)
    libavformat.so.63 => /sdk/lib/libavformat.so.63 (0x00007abc)
    libx264.so.164 => /lib/x86_64-linux-gnu/libx264.so.164 (0x00007def)
    /lib64/ld-linux-x86-64.so.2 (0x00007fff)
  `)], [
    ["libavformat.so.63", "/sdk/lib/libavformat.so.63"],
    ["libx264.so.164", "/lib/x86_64-linux-gnu/libx264.so.164"],
  ]);
  assert.throws(() => parseDependencies("libavformat.so.63 => not found"), /Missing shared library/);
});

test("Linux packages carry a private runtime instead of FFmpeg 6 package dependencies", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../../src-tauri/tauri.linux.conf.json", import.meta.url), "utf8"));
  assert.equal(config.build.beforeBundleCommand, "node scripts/bundle-linux-ffmpeg.mjs");
  assert.equal(config.bundle.resources["target/ffmpeg-runtime/"], "ffmpeg-runtime/");
  assert.equal(config.bundle.linux.deb.depends.some(name => /^lib(?:av|swresample)/.test(name)), false);
});
