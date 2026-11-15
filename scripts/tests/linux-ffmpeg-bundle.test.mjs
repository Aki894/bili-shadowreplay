import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appImageEnvironment, parseDependencies, systemLibrary, verifyAppImageLaunch } from "../bundle-linux-ffmpeg.mjs";

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
  assert.equal(config.bundle.linux.appimage.files["/usr/lib"], "target/ffmpeg-runtime");
  assert.equal(config.bundle.linux.deb.depends.some(name => /^lib(?:av|swresample)/.test(name)), false);
});

test("AppImage verification uses a package-owned search path without preload or CWD", () => {
  const root = path.resolve("AppDir");
  const env = appImageEnvironment(root);
  assert.equal(env.LD_LIBRARY_PATH, path.join(root, "usr/lib"));
  assert.equal(env.LD_PRELOAD, undefined);
});

test("AppRun trace validation distinguishes the application from launcher subprocesses", { skip: process.platform === "win32" }, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "appimage-trace-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "AppDir");
  const runtime = path.join(root, "usr/lib/bili-shadowreplay/ffmpeg-runtime");
  const host = path.join(base, "host");
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(host);
  const names = ["libavformat.so.63", "libfontconfig.so.1", "libfribidi.so.0"];
  for (const name of names) {
    fs.writeFileSync(path.join(runtime, name), "");
    fs.writeFileSync(path.join(root, "usr/lib", name), "");
    fs.writeFileSync(path.join(host, name), "");
  }
  const trace = [
    `1: calling init: ${host}/libfontconfig.so.1`,
    ...names.map(name => `42: calling init: ${root}/usr/lib/${name}`),
    "42: initialize program: bili-shadowreplay",
  ].join("\n");
  assert.doesNotThrow(() => verifyAppImageLaunch(trace, runtime, root));
  assert.throws(() => verifyAppImageLaunch(
    trace.replace(`${root}/usr/lib/libfontconfig.so.1`, `${host}/libfontconfig.so.1`),
    runtime, root,
  ), /AppRun loaded a system copy/);
  assert.throws(() => verifyAppImageLaunch(
    trace.replace(`42: calling init: ${root}/usr/lib/libfribidi.so.0`, ""),
    runtime, root,
  ), /did not initialize libfribidi/);
  assert.throws(() => verifyAppImageLaunch("", runtime, root), /Expected one application process/);
  assert.throws(() => verifyAppImageLaunch(
    `${trace}\n43: initialize program: bili-shadowreplay`, runtime, root,
  ), /Expected one application process/);
});
