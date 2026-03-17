/**
 * Tauri desktop app process management for Claw Sama.
 */
import type { ChildProcess } from "node:child_process";
import { spawn, execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

let tauriProcess: ChildProcess | null = null;

/** Resolved binary info */
interface ResolvedBinary {
  path: string;
  isAppBundle: boolean;
}

/** Platform sub-package mapping: `${process.platform}-${process.arch}` → package + binary/app name */
const PLATFORM_PACKAGES: Record<string, { pkg: string; bin: string; isAppBundle: boolean }> = {
  "win32-x64":    { pkg: "@luckybugqqq/claw-sama-win32-x64",   bin: "claw-sama.exe",    isAppBundle: false },
  "darwin-arm64": { pkg: "@luckybugqqq/claw-sama-darwin-arm64", bin: "Claw Sama.app",    isAppBundle: true },
  "darwin-x64":   { pkg: "@luckybugqqq/claw-sama-darwin-x64",   bin: "Claw Sama.app",    isAppBundle: true },
};

/** Try to resolve binary from the installed optional dependency package. */
function resolveFromOptionalDep(): ResolvedBinary | null {
  const key = `${process.platform}-${process.arch}`;
  const entry = PLATFORM_PACKAGES[key];
  if (!entry) return null;
  try {
    const pkgJson = require.resolve(`${entry.pkg}/package.json`);
    const binPath = path.join(path.dirname(pkgJson), entry.bin);
    if (existsSync(binPath)) return { path: binPath, isAppBundle: entry.isAppBundle };
  } catch {
    // Package not installed (wrong platform or dev environment)
  }
  return null;
}

function resolveBuiltBinary(appDir: string): ResolvedBinary | null {
  // 1. Try installed optional dependency (production path via npm)
  const fromDep = resolveFromOptionalDep();
  if (fromDep) {
    if (!fromDep.isAppBundle && process.platform !== "win32") {
      try { execFileSync("chmod", ["+x", fromDep.path]); } catch {}
    }
    return fromDep;
  }

  // 2. Fallback: local build directory (development)
  // On macOS, prefer .app bundle from bundle/macos/
  if (process.platform === "darwin") {
    const macArch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const bundleDir = path.join(appDir, "src-tauri", "target", `${macArch}-apple-darwin`, "release", "bundle", "macos");
    const appBundlePath = path.join(bundleDir, "Claw Sama.app");
    if (existsSync(appBundlePath)) {
      return { path: appBundlePath, isAppBundle: true };
    }
    // Also check target/release/bundle/macos for non-cross builds
    const localBundleDir = path.join(appDir, "src-tauri", "target", "release", "bundle", "macos");
    const localAppBundle = path.join(localBundleDir, "Claw Sama.app");
    if (existsSync(localAppBundle)) {
      return { path: localAppBundle, isAppBundle: true };
    }
  }

  const releaseDir = path.join(appDir, "src-tauri", "target", "release");
  const macArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const candidates: string[] =
    process.platform === "win32" ? [
      path.join(releaseDir, "claw-sama.exe"),
    ] : process.platform === "darwin" ? [
      path.join(releaseDir, `claw-sama-${macArch}-apple-darwin`),
      path.join(releaseDir, "claw-sama"),
    ] : [
      path.join(releaseDir, "claw-sama"),
    ];
  for (const p of candidates) {
    if (existsSync(p)) {
      if (process.platform !== "win32") {
        try { execFileSync("chmod", ["+x", p]); } catch {}
      }
      return { path: p, isAppBundle: false };
    }
  }
  return null;
}

export function launchTauri(appDir: string, log: { info: (msg: string) => void; warn: (msg: string) => void }) {
  const resolved = resolveBuiltBinary(appDir);
  if (resolved) {
    log.info(`Launching Claw Sama: ${resolved.path} (appBundle=${resolved.isAppBundle})`);

    if (resolved.isAppBundle && process.platform === "darwin") {
      // macOS: launch .app bundle with `open -W -a`
      tauriProcess = spawn("open", ["-W", "-a", resolved.path], { stdio: "ignore" });
    } else {
      tauriProcess = spawn(resolved.path, [], { cwd: path.dirname(resolved.path), stdio: "ignore" });
    }

    tauriProcess.on("error", (err) => {
      log.warn(`Claw Sama process error: ${err.message}`);
      tauriProcess = null;
    });
    tauriProcess.on("exit", (code) => {
      log.info(`Claw Sama process exited (code: ${code})`);
      tauriProcess = null;
    });
    return;
  }

  if (!existsSync(appDir)) {
    log.warn(`Claw Sama: no pre-built binary and app directory not found: ${appDir}`);
    return;
  }

  log.info(`No pre-built binary found. Starting dev mode: npx tauri dev (cwd: ${appDir})`);

  const needsInstall = !existsSync(path.join(appDir, "node_modules"));
  const doDevLaunch = () => {
    const devProc = spawn("npx", ["tauri", "dev"], {
      cwd: appDir,
      stdio: "inherit",
      shell: true,
    });
    tauriProcess = devProc;
    devProc.on("error", (err) => {
      log.warn(`Claw Sama dev error: ${err.message}`);
      tauriProcess = null;
    });
    devProc.on("exit", (code) => {
      log.info(`Claw Sama dev exited (code: ${code})`);
      tauriProcess = null;
    });
  };

  if (needsInstall) {
    log.info(`Installing frontend dependencies: npm install (cwd: ${appDir})`);
    const installProc = spawn("npm", ["install"], {
      cwd: appDir,
      stdio: "inherit",
      shell: true,
    });
    installProc.on("exit", (installCode) => {
      if (installCode !== 0) {
        log.warn(`Claw Sama npm install failed (code: ${installCode})`);
        return;
      }
      doDevLaunch();
    });
  } else {
    doDevLaunch();
  }
}

export function stopTauri(log: { info: (msg: string) => void }) {
  if (tauriProcess) {
    log.info("Stopping Claw Sama...");
    const proc = tauriProcess;
    tauriProcess = null;

    if (process.platform === "darwin") {
      // Gracefully quit macOS app
      try {
        execSync('osascript -e \'quit app "Claw Sama"\'', { timeout: 5000 });
      } catch {
        proc?.kill("SIGTERM");
      }
    } else {
      proc?.kill("SIGTERM");
    }

    setTimeout(() => {
      try { if (proc && !proc.killed) proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, 3000);
  }
}
