import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The macOS dictation and read-aloud helpers ship outside asar as one universal binary each.
// Other platforms have none; a Mac without Swift builds the app and the page falls back.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Electron 45's own minimum.
const MACOS_TARGET = "12";
const HELPERS = [
  { dir: "speech", name: "rakazo-speech", purpose: "dictation" },
  { dir: "voice", name: "rakazo-voice", purpose: "read-aloud" },
];

if (process.platform !== "darwin") process.exit(0);

for (const { dir, name, purpose } of HELPERS) {
  const source = path.join(root, "native", dir);
  const out = path.join(root, "build", dir);
  const helper = path.join(out, name);

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const slices = [];
  for (const arch of ["arm64", "x86_64"]) {
    const slice = path.join(out, `${name}-${arch}`);
    const result = spawnSync(
      "xcrun",
      [
        "swiftc",
        "-O",
        "-swift-version",
        "5",
        "-target",
        `${arch}-apple-macos${MACOS_TARGET}`,
        path.join(source, "main.swift"),
        "-Xlinker",
        "-sectcreate",
        "-Xlinker",
        "__TEXT",
        "-Xlinker",
        "__info_plist",
        "-Xlinker",
        path.join(source, "Info.plist"),
        "-o",
        slice,
      ],
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
    );
    if (result.status === 0) slices.push(slice);
    // Command Line Tools alone cannot link x86_64 for macOS 12; release builds verify both slices.
    else
      console.warn(
        `Skipped the ${arch} ${purpose} helper: ${result.stderr?.trim() || result.error}`,
      );
  }

  if (slices.length > 0) {
    const lipo = spawnSync("xcrun", ["lipo", "-create", "-output", helper, ...slices], {
      stdio: "inherit",
    });
    if (lipo.status !== 0) process.exit(lipo.status ?? 1);
  }
  await Promise.all(slices.map((slice) => rm(slice, { force: true })));
}
