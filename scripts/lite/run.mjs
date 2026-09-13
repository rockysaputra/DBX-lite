import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [mode, ...flags] = process.argv.slice(2);
if (!["build", "dev", "start"].includes(mode) || flags.some((flag) => flag !== "--debug")) {
  console.error("Usage: node scripts/lite/run.mjs build|dev|start [--debug]");
  process.exit(2);
}
const environment = {
  ...process.env,
  RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN || "1.94.1",
  CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG || "0",
  CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL || "0",
  DBX_DATA_DIR: resolve(process.env.DBX_DATA_DIR || resolve(root, ".dbx-lite-data")),
};
mkdirSync(environment.DBX_DATA_DIR, { recursive: true });
let command = process.execPath;
let args = [resolve(root, "node_modules/@tauri-apps/cli/tauri.js"), mode, "--config", "src-tauri/tauri.lite.conf.json", "--features", "lite"];
if (mode === "start") {
  const profile = flags.includes("--debug") ? "debug" : "release";
  command = process.platform === "darwin" ? resolve(root, `target/${profile}/bundle/macos/DBX Lite.app/Contents/MacOS/dbx`) : resolve(root, `target/${profile}/dbx${process.platform === "win32" ? ".exe" : ""}`);
  if (!existsSync(command)) {
    console.error(`Build DBX Lite first: node scripts/lite/run.mjs build${profile === "debug" ? " --debug" : ""}`);
    process.exit(1);
  }
  args = [];
} else {
  if (mode === "build" && flags.includes("--debug")) args.push("--debug");
  args.push("--", "--no-default-features");
}
const child = spawn(command, args, { cwd: root, env: environment, stdio: "inherit" });
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
