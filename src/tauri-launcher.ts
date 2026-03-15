/**
 * Tauri desktop app process management for Claw Sama.
 */
import type { ChildProcess } from "node:child_process";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

let tauriProcess: ChildProcess | null = null;

function resolveBuiltBinary(appDir: string): string | null {
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
      return p;
    }
  }
  return null;
}

export function launchTauri(appDir: string, log: { info: (msg: string) => void; warn: (msg: string) => void }) {
  if (!existsSync(appDir)) {
    log.warn(`Claw Sama app directory not found: ${appDir}`);
    return;
  }

  const binPath = resolveBuiltBinary(appDir);
  if (binPath) {
    log.info(`Launching Claw Sama: ${binPath}`);
    tauriProcess = spawn(binPath, [], { cwd: appDir, stdio: "ignore" });
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
    proc?.kill("SIGTERM");
    setTimeout(() => {
      try { if (proc && !proc.killed) proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, 3000);
  }
}
