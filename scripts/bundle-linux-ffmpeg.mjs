import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const nativeRoot = fileURLToPath(new URL("../src-tauri/", import.meta.url));
const runtimePath = "../lib/bili-shadowreplay/ffmpeg-runtime";
const mediaLibrary = /^lib(?:avcodec|avformat|avutil|avfilter|swresample|swscale)\.so\.\d+$/;
// Keep the loader, glibc and C/C++ runtimes on the supported host baseline.
export const systemLibrary = (name) => /^(?:ld-linux[^/]*|lib(?:c|m|dl|pthread|rt|resolv|util|anl|gcc_s|stdc\+\+))\.so(?:\.\d+)*$/.test(name);
const cleanEnv = { ...process.env, LC_ALL: "C" };
delete cleanEnv.LD_LIBRARY_PATH;
delete cleanEnv.LD_PRELOAD;
const run = (program, args, env = cleanEnv) =>
  execFileSync(program, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();

export function parseDependencies(output) {
  const result = new Map();
  for (const line of output.split("\n")) {
    if (line.includes("=> not found")) throw new Error(`Missing shared library: ${line.trim()}`);
    const match = line.trim().match(/^(\S+) => (\/.+) \(0x[0-9a-f]+\)$/);
    if (match) result.set(match[1], match[2]);
  }
  return result;
}

function dependencies(binary, env) {
  return parseDependencies(run("ldd", [binary], env));
}

function copyLicenses(libraries, sdk, directory) {
  const destination = path.join(directory, "licenses");
  fs.cpSync(path.join(sdk, "../share/ffmpeg-licenses"), path.join(destination, "ffmpeg"), { recursive: true });
  const packages = new Set();
  const sdkRoot = fs.realpathSync(sdk) + path.sep;
  for (const source of libraries.values()) {
    if (source.startsWith(sdkRoot)) continue;
    // Ubuntu's merged-/usr layout may record the same library under /lib.
    const candidates = [source, source.replace(/^\/usr\/lib\//, "/lib/")];
    let owner;
    for (const candidate of candidates) {
      try {
        owner = run("dpkg-query", ["--search", candidate]).split("\n")[0].split(": ")[0].split(":")[0];
        break;
      } catch { /* Try the other merged-/usr spelling. */ }
    }
    if (!owner) throw new Error(`Cannot find license package for ${source}`);
    packages.add(owner);
  }
  for (const name of packages) {
    const source = `/usr/share/doc/${name}/copyright`;
    fs.copyFileSync(source, path.join(destination, `${name}.copyright`));
  }
}

export function verify(binary, directory, packageRoot = directory) {
  const files = fs.readdirSync(directory).filter((name) => name.includes(".so"));
  if (!files.some((name) => /^libavformat\.so\.63$/.test(name))) {
    throw new Error("FFmpeg 9 runtime (libavformat.so.63) is missing");
  }
  const bundled = new Set(files);
  for (const file of [binary, ...files.map((name) => path.join(directory, name))]) {
    const isLibrary = file !== binary;
    const linked = dependencies(file);
    if (!isLibrary && !linked.has("libavformat.so.63")) throw new Error("Packaged application does not load FFmpeg 9");
    for (const [name, location] of linked) {
      if (bundled.has(name)) {
        // linuxdeploy may relocate AppImage libraries into AppDir/usr/lib.
        // They must still resolve inside the extracted package, never the SDK.
        if (!fs.realpathSync(location).startsWith(fs.realpathSync(packageRoot) + path.sep)) {
          throw new Error(`Library escaped private runtime: ${name} => ${location}`);
        }
      } else if (mediaLibrary.test(name) || (isLibrary && !systemLibrary(name))) {
        throw new Error(`Unbundled media dependency: ${name}`);
      }
    }
  }
  console.log(`Verified ${files.length} Linux runtime libraries without LD_LIBRARY_PATH`);
}

export function bundle(binary, directory, sdk) {
  if (!fs.existsSync(binary)) throw new Error(`Application executable not found: ${binary}`);
  // Resolve the SDK first, even if this binary was already patched by a prior bundle.
  const env = { ...cleanEnv, LD_LIBRARY_PATH: sdk };
  const roots = fs.readdirSync(sdk).filter((name) => mediaLibrary.test(name));
  if (!roots.includes("libavformat.so.63")) throw new Error("Linux packaging requires the FFmpeg 9 SDK");
  const libraries = new Map();
  const add = (name, file) => {
    if (systemLibrary(name)) return;
    if (path.basename(name) !== name) throw new Error(`Invalid library name: ${name}`);
    const source = fs.realpathSync(file);
    if (libraries.has(name) && libraries.get(name) !== source) throw new Error(`Conflicting library: ${name}`);
    libraries.set(name, source);
  };
  for (const name of roots) {
    const file = path.join(sdk, name);
    add(name, file);
    // ldd includes the full transitive dependency closure.
    for (const [dependency, location] of dependencies(file, env)) add(dependency, location);
  }
  const linked = dependencies(binary, env);
  if (!linked.has("libavformat.so.63")) throw new Error("Application was not linked against FFmpeg 9");
  for (const [name, location] of linked) {
    if (mediaLibrary.test(name) && libraries.get(name) !== fs.realpathSync(location)) {
      throw new Error(`Application and packaging SDK differ: ${name}`);
    }
  }
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const temporary = fs.mkdtempSync(`${directory}.`);
  try {
    for (const [name, source] of libraries) {
      const target = path.join(temporary, name);
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o755);
      run("patchelf", ["--set-rpath", "$ORIGIN", target]);
    }
    copyLicenses(libraries, sdk, temporary);
    // Only the generated runtime directory is replaced, never system libraries.
    fs.rmSync(directory, { recursive: true, force: true });
    fs.renameSync(temporary, directory);
    run("patchelf", ["--set-rpath", `$ORIGIN/${runtimePath}`, binary]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`Bundled ${libraries.size} Linux runtime libraries in ${directory}`);
}

function main() {
  if (process.platform !== "linux") throw new Error("Linux bundling requires ldd and patchelf");
  const args = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
    return path.resolve(args[index + 1]);
  };
  const profile = process.env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";
  const target = process.env.CARGO_TARGET_DIR
    ? path.resolve(nativeRoot, process.env.CARGO_TARGET_DIR) : path.join(nativeRoot, "target");
  const triple = process.env.RUST_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE;
  const candidates = process.env.RUST_TARGET
    ? [path.join(target, triple, profile, "bili-shadowreplay")]
    : [triple && path.join(target, triple, profile, "bili-shadowreplay"), path.join(target, profile, "bili-shadowreplay")].filter(Boolean);
  const existing = candidates.filter((file) => fs.existsSync(file));
  const explicit = flag("--binary");
  if (!explicit && existing.length !== 1) throw new Error("Set RUST_TARGET to select exactly one application executable");
  const binary = explicit || existing[0];
  const directory = flag("--runtime") || path.join(nativeRoot, "target/ffmpeg-runtime");
  if (args.includes("--verify")) verify(binary, directory, flag("--package-root"));
  else bundle(binary, directory, run("pkg-config", ["--variable=libdir", "libavformat"]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
